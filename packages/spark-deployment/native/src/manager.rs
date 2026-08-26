// The deployment owner is implemented in this module. It deliberately uses
// synchronous I/O: updater operations are serialized by one process lock and
// there is no second daemon or async scheduler in the native CLI.

use crate::model::{
    AvailableRelease, BuildInfo, Installation, QuarantinedVersion, UpdateChannel, UpdateConfig,
    UpdateFailure, UpdatePaths, UpdatePolicy, UpdateState, UpdateStatus,
};
use crate::paths::{installed_native_binary, resolve_paths};
use crate::registry::{query_channel, query_exact, registry_root};
use crate::state::{
    StateRead, UpdateLock, atomic_write, native_state, read_config, read_state, write_config,
    write_state,
};
use crate::util::{
    backup_timestamp, now_rfc3339, parse_json_output, rfc3339_after_minutes, run_command,
    shell_quote,
};
use semver::Version;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::env;
use std::ffi::{OsStr, OsString};
use std::fs;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::time::Duration;

const PROTOCOL_VERSION: u32 = 3;
const PACKAGE_NAME: &str = "@zendev-lab/spark";

#[derive(Clone, Debug, Default)]
pub struct ManagerOptions {
    pub prefix: Option<PathBuf>,
    pub build_info: Option<BuildInfo>,
    pub command_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
pub struct UpdateError {
    pub code: &'static str,
    pub message: String,
}

impl UpdateError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for UpdateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for UpdateError {}

pub type Result<T> = std::result::Result<T, UpdateError>;

fn update_error(message: impl Into<String>) -> UpdateError {
    UpdateError::new("UPDATE_FAILED", message)
}

fn legacy_error() -> UpdateError {
    UpdateError::new(
        "LEGACY_MANAGED_INSTALL",
        "The native updater will not modify schema v1 deployment state; run `spark install --managed` to create a backed-up native generation.",
    )
}

pub struct Manager {
    pub paths: UpdatePaths,
    build_info: BuildInfo,
    command_path: Option<PathBuf>,
    product_root: Option<PathBuf>,
}

impl Manager {
    pub fn new(options: ManagerOptions) -> Result<Self> {
        let paths = resolve_paths(options.prefix.as_deref()).map_err(update_error)?;
        let build_info = options.build_info.map(Ok).unwrap_or_else(read_build_info)?;
        let product_root = env::var_os("SPARK_PRODUCT_DIST")
            .map(PathBuf::from)
            .and_then(|path| path.parent().map(Path::to_path_buf));
        let command_path = options
            .command_path
            .or_else(|| env::var_os("SPARK_CLI_COMMAND_PATH").map(PathBuf::from))
            .or_else(|| env::var_os("SPARK_STABLE_LAUNCHER").map(PathBuf::from))
            .or_else(find_spark_on_path);
        Ok(Self {
            paths,
            build_info,
            command_path,
            product_root,
        })
    }

    pub fn build_info(&self) -> &BuildInfo {
        &self.build_info
    }

    pub fn status(&self) -> Result<UpdateStatus> {
        let config = read_config(&self.paths).map_err(update_error)?;
        let state_read = read_state(&self.paths).map_err(update_error)?;
        let legacy_state = matches!(state_read, StateRead::Legacy);
        let mut state = match state_read {
            StateRead::Native(state) => *state,
            StateRead::Legacy => UpdateState::default(),
        };
        let managed = managed_current_link(&self.paths);
        let installation =
            self.resolve_installation(managed, &config, state.current_version.clone());
        if matches!(
            installation.method.as_str(),
            "container" | "vp" | "pnpm" | "yarn" | "bun" | "npm"
        ) {
            state.current_version = installation.version.clone();
            state.current_fingerprint = Some(self.build_info.fingerprint.clone());
        }
        let repair_command = if legacy_state {
            Some("spark install --managed".to_owned())
        } else if matches!(installation.method.as_str(), "source" | "unknown") {
            let prefix = self
                .paths
                .launcher_path
                .parent()
                .and_then(Path::parent)
                .unwrap_or_else(|| Path::new("~/.local"));
            Some(format!(
                "spark install --managed --prefix {}",
                shell_quote(prefix.as_os_str())
            ))
        } else {
            None
        };
        Ok(UpdateStatus {
            managed,
            legacy_state,
            installation,
            config,
            state,
            paths: self.paths.clone(),
            repair_command,
        })
    }

    pub fn configure(&self, change: ConfigureChange) -> Result<UpdateConfig> {
        self.reject_legacy()?;
        let mut config = read_config(&self.paths).map_err(update_error)?;
        if let Some(policy) = change.policy {
            config.policy = policy;
        }
        if let Some(channel) = change.channel {
            config.channel = channel;
        }
        if let Some(interval) = change.check_interval_hours {
            config.check_interval_hours = interval;
        }
        write_config(&self.paths, &config).map_err(update_error)?;
        self.install_macos_updater_job(&config)?;
        Ok(config)
    }

    pub fn check(&mut self, background: bool) -> Result<UpdateStatus> {
        let _lock = UpdateLock::acquire(&self.paths).map_err(update_error)?;
        self.check_locked(background)
    }

    fn check_locked(&mut self, background: bool) -> Result<UpdateStatus> {
        self.reject_legacy()?;
        let config = read_config(&self.paths).map_err(update_error)?;
        if background && config.policy == UpdatePolicy::Manual {
            return self.status();
        }
        let mut state = native_state(&self.paths).map_err(|error| {
            if error == "LEGACY_MANAGED_INSTALL" {
                legacy_error()
            } else {
                update_error(error)
            }
        })?;
        if background && !network_check_due(&config, &state) {
            return self.status();
        }
        let managed = managed_current_link(&self.paths);
        let installation =
            self.resolve_installation(managed, &config, state.current_version.clone());
        if !managed && let Some(version) = installation.version.as_ref() {
            state.current_version = Some(version.clone());
            state.current_fingerprint = Some(self.build_info.fingerprint.clone());
        }
        let release = match query_channel(&config.channel, state.registry_etag.as_deref()) {
            Ok(release) => release,
            Err(error) => {
                self.record_failure(&mut state, "registry_check_failed", &error, None)?;
                return Err(update_error(error));
            }
        };
        state.last_check_at = Some(now_rfc3339());
        if let Some(etag) = release.etag.clone() {
            state.registry_etag = Some(etag);
        }
        if !release.not_modified {
            state.available_version = (Some(&release.version) != state.current_version.as_ref())
                .then(|| release.version.clone());
        }
        state.failure = None;
        write_state(&self.paths, &state).map_err(update_error)?;
        if background
            && config.policy == UpdatePolicy::Auto
            && !release.not_modified
            && state.available_version.as_deref() == Some(release.version.as_str())
            && can_automatically_apply(state.current_version.as_deref(), &release.version)
            && !is_quarantined(&state, &release.version)
        {
            if managed && self.daemon_is_idle(self.paths.launcher_path.as_path()) {
                return self.apply_managed_locked(Some(release), false, true);
            }
            if !managed
                && installation.automatic_updates
                && installation
                    .command_path
                    .as_deref()
                    .is_some_and(|path| self.daemon_is_idle(path))
            {
                return self.apply_package_manager_locked(Some(release), installation, true);
            }
        }
        self.status()
    }

    pub fn install_managed(&mut self, version: Option<&str>) -> Result<UpdateStatus> {
        let _lock = UpdateLock::acquire(&self.paths).map_err(update_error)?;
        let legacy = matches!(
            read_state(&self.paths).map_err(update_error)?,
            StateRead::Legacy
        );
        let mut backup = if legacy {
            Some(LegacyBackup::create(&self.paths)?)
        } else {
            None
        };
        let result = (|| {
            let release = match version {
                Some(version) => query_exact(version).map_err(update_error)?,
                None => {
                    let config = read_config(&self.paths).map_err(update_error)?;
                    query_channel(&config.channel, None).map_err(update_error)?
                }
            };
            self.apply_managed_locked(Some(release), true, false)
        })();
        match result {
            Ok(status) => {
                if let Some(backup) = backup.as_mut() {
                    let record_backup = (|| {
                        let mut state = native_state(&self.paths).map_err(update_error)?;
                        state.legacy_backups.push(backup.root.clone());
                        write_state(&self.paths, &state).map_err(update_error)
                    })();
                    if let Err(error) = record_backup {
                        backup.restore(&self.paths)?;
                        return Err(error);
                    }
                }
                let config = read_config(&self.paths).map_err(update_error)?;
                self.install_macos_updater_job(&config)?;
                self.status().or(Ok(status))
            }
            Err(error) => {
                if let Some(backup) = backup.as_mut() {
                    backup.restore(&self.paths)?;
                }
                Err(error)
            }
        }
    }

    pub fn apply(&mut self, requested: Option<&str>, automatic: bool) -> Result<UpdateStatus> {
        let _lock = UpdateLock::acquire(&self.paths).map_err(update_error)?;
        self.reject_legacy()?;
        let release = requested
            .map(query_exact)
            .transpose()
            .map_err(update_error)?;
        if managed_current_link(&self.paths) {
            return self.apply_managed_locked(release, false, automatic);
        }
        let status = self.status()?;
        if status.installation.automatic_updates {
            self.apply_package_manager_locked(release, status.installation, automatic)
        } else {
            Err(update_error(
                "This Spark installation cannot update itself. Use the reported package-manager command or run `spark install --managed`.",
            ))
        }
    }

    fn apply_managed_locked(
        &mut self,
        release: Option<AvailableRelease>,
        initial_install: bool,
        automatic: bool,
    ) -> Result<UpdateStatus> {
        if !initial_install {
            self.reject_legacy()?;
            if !managed_current_link(&self.paths) {
                return Err(update_error(
                    "This Spark installation is not managed. Run `spark install --managed` first; source checkouts are never modified.",
                ));
            }
        }
        let config = read_config(&self.paths).map_err(update_error)?;
        let mut state = if initial_install {
            match read_state(&self.paths).map_err(update_error)? {
                StateRead::Native(state) => *state,
                StateRead::Legacy => UpdateState::default(),
            }
        } else {
            native_state(&self.paths).map_err(update_error)?
        };
        let release = release
            .map(Ok)
            .unwrap_or_else(|| query_channel(&config.channel, None).map_err(update_error))?;
        exact_version(&release.version)?;
        if is_quarantined(&state, &release.version) {
            return Err(update_error(format!(
                "Spark {} is quarantined. Run `spark update retry {} --yes` before applying it again.",
                release.version, release.version
            )));
        }
        if automatic && !can_automatically_apply(state.current_version.as_deref(), &release.version)
        {
            state.available_version = Some(release.version);
            write_state(&self.paths, &state).map_err(update_error)?;
            return self.status();
        }
        let version = release.version.clone();
        let previous_version = state.current_version.clone();
        let previous_fingerprint = state.current_fingerprint.clone();
        let hub = self.read_hub_service(&self.paths.launcher_path);
        let candidate = match self.stage_candidate(&release) {
            Ok(candidate) => candidate,
            Err(error) => {
                self.quarantine_and_fail(
                    &mut state,
                    &version,
                    "update_apply_failed",
                    &error.message,
                )?;
                return Err(error);
            }
        };
        state.available_version = Some(version.clone());
        state.pending_version = Some(version.clone());
        state.pending_fingerprint = Some(candidate.fingerprint.clone());
        write_state(&self.paths, &state).map_err(update_error)?;
        if automatic && !self.daemon_is_idle(&self.paths.launcher_path) {
            return self.status();
        }
        self.activate_version(&version)?;
        self.write_stable_launcher()?;
        state.current_version = Some(version.clone());
        state.current_fingerprint = Some(candidate.fingerprint.clone());
        state.rollback_version = previous_version.clone();
        state.rollback_fingerprint = previous_fingerprint.clone();
        write_state(&self.paths, &state).map_err(update_error)?;
        if let Err(error) = self.verify_candidate(&candidate, &hub) {
            if let Some(previous) = previous_version.as_deref() {
                self.activate_version(previous)?;
                self.write_stable_launcher()?;
                state.current_version = previous_version;
                state.current_fingerprint = previous_fingerprint;
                state.pending_version = None;
                state.pending_fingerprint = None;
                self.quarantine_and_fail(
                    &mut state,
                    &version,
                    "update_apply_failed",
                    &error.message,
                )?;
            } else {
                state.current_version = None;
                state.current_fingerprint = None;
                state.pending_version = None;
                state.pending_fingerprint = None;
                self.quarantine_and_fail(
                    &mut state,
                    &version,
                    "update_apply_failed",
                    &error.message,
                )?;
            }
            return Err(error);
        }
        state.last_good_version = Some(version.clone());
        state.last_good_fingerprint = Some(candidate.fingerprint.clone());
        state.available_version = None;
        state.pending_version = None;
        state.pending_fingerprint = None;
        state.failure = None;
        write_state(&self.paths, &state).map_err(update_error)?;
        self.build_info = candidate;
        self.status()
    }

    fn apply_package_manager_locked(
        &mut self,
        release: Option<AvailableRelease>,
        installation: Installation,
        automatic: bool,
    ) -> Result<UpdateStatus> {
        let command_path = installation.command_path.clone().ok_or_else(|| {
            update_error("Spark cannot locate the package-manager installation command")
        })?;
        let current = installation
            .version
            .clone()
            .ok_or_else(|| update_error("Spark cannot identify the installed version"))?;
        let config = read_config(&self.paths).map_err(update_error)?;
        let release = release
            .map(Ok)
            .unwrap_or_else(|| query_channel(&config.channel, None).map_err(update_error))?;
        if release.version == current {
            let mut state = native_state(&self.paths).map_err(update_error)?;
            state.current_version = Some(current);
            state.current_fingerprint = Some(self.build_info.fingerprint.clone());
            state.available_version = None;
            write_state(&self.paths, &state).map_err(update_error)?;
            return self.status();
        }
        if automatic && !can_automatically_apply(Some(&current), &release.version) {
            let mut state = native_state(&self.paths).map_err(update_error)?;
            state.available_version = Some(release.version);
            write_state(&self.paths, &state).map_err(update_error)?;
            return self.status();
        }
        if automatic && !self.daemon_is_idle(&command_path) {
            let mut state = native_state(&self.paths).map_err(update_error)?;
            state.available_version = Some(release.version);
            write_state(&self.paths, &state).map_err(update_error)?;
            return self.status();
        }
        let hub = self.read_hub_service(&command_path);
        let update =
            package_manager_command(&installation.method, &release.version, &command_path)?;
        let result = run_command(&update.0, update.1.iter(), Duration::from_secs(120))
            .map_err(update_error)?;
        if result.code != 0 {
            return Err(update_error(format!(
                "{} update failed: {}",
                installation.method,
                result.stderr.trim()
            )));
        }
        let previous_build = self.build_info.clone();
        let candidate = self.read_build_from_launcher(&command_path)?;
        if candidate.version != release.version || candidate.deployment_generation != Some(2) {
            let _ = self.restore_package_manager(&installation, &current, &command_path, &hub);
            return Err(update_error(format!(
                "{} installed an incompatible Spark build for {}",
                installation.method, release.version
            )));
        }
        if let Err(error) = self.verify_candidate_at(&candidate, &command_path, &hub) {
            self.restore_package_manager(&installation, &current, &command_path, &hub)?;
            return Err(error);
        }
        self.build_info = candidate.clone();
        let mut state = native_state(&self.paths).map_err(update_error)?;
        state.current_version = Some(candidate.version.clone());
        state.current_fingerprint = Some(candidate.fingerprint.clone());
        state.last_good_version = Some(candidate.version.clone());
        state.last_good_fingerprint = Some(candidate.fingerprint.clone());
        state.rollback_version = Some(current);
        state.rollback_fingerprint = Some(previous_build.fingerprint);
        state.available_version = None;
        state.pending_version = None;
        state.failure = None;
        write_state(&self.paths, &state).map_err(update_error)?;
        self.status()
    }

    pub fn rollback(&mut self) -> Result<UpdateStatus> {
        let _lock = UpdateLock::acquire(&self.paths).map_err(update_error)?;
        self.reject_legacy()?;
        let mut state = native_state(&self.paths).map_err(update_error)?;
        let target = state
            .rollback_version
            .clone()
            .or_else(|| {
                (state.last_good_version != state.current_version)
                    .then(|| state.last_good_version.clone())
                    .flatten()
            })
            .ok_or_else(|| update_error("No rollback Spark version is available"))?;
        if !managed_current_link(&self.paths) {
            let status = self.status()?;
            let current = status.installation.version.clone();
            let command_path = status.installation.command_path.clone().ok_or_else(|| {
                update_error("This Spark installation cannot roll back automatically")
            })?;
            let hub = self.read_hub_service(&command_path);
            let build =
                self.restore_package_manager(&status.installation, &target, &command_path, &hub)?;
            state.rollback_version = current;
            state.current_version = Some(target.clone());
            state.current_fingerprint = Some(build.fingerprint.clone());
            state.last_good_version = Some(target);
            state.last_good_fingerprint = Some(build.fingerprint);
            state.failure = None;
            write_state(&self.paths, &state).map_err(update_error)?;
            return self.status();
        }
        let previous = state.current_version.clone();
        let previous_fingerprint = state.current_fingerprint.clone();
        let build = self.read_installed_build(&target)?;
        let hub = self.read_hub_service(&self.paths.launcher_path);
        self.activate_version(&target)?;
        self.write_stable_launcher()?;
        state.current_version = Some(target.clone());
        state.current_fingerprint = Some(build.fingerprint.clone());
        write_state(&self.paths, &state).map_err(update_error)?;
        if let Err(error) = self.verify_candidate(&build, &hub) {
            if let Some(previous) = previous.as_deref() {
                self.activate_version(previous)?;
                self.write_stable_launcher()?;
            }
            state.current_version = previous;
            state.current_fingerprint = previous_fingerprint;
            self.record_failure(
                &mut state,
                "update_rollback_failed",
                &error.message,
                Some(&target),
            )?;
            return Err(error);
        }
        state.last_good_version = Some(target.clone());
        state.last_good_fingerprint = Some(build.fingerprint.clone());
        state.rollback_version = previous;
        state.rollback_fingerprint = previous_fingerprint;
        state.failure = None;
        write_state(&self.paths, &state).map_err(update_error)?;
        self.build_info = build;
        self.status()
    }

    pub fn retry(&mut self, version: Option<&str>) -> Result<UpdateStatus> {
        let _lock = UpdateLock::acquire(&self.paths).map_err(update_error)?;
        self.reject_legacy()?;
        let mut state = native_state(&self.paths).map_err(update_error)?;
        let target = version
            .map(str::to_owned)
            .or_else(|| state.available_version.clone())
            .or_else(|| state.pending_version.clone())
            .ok_or_else(|| update_error("No failed or available Spark version was selected"))?;
        state.quarantined.retain(|entry| entry.version != target);
        if state
            .failure
            .as_ref()
            .and_then(|failure| failure.version.as_ref())
            == Some(&target)
        {
            state.failure = None;
        }
        write_state(&self.paths, &state).map_err(update_error)?;
        if managed_current_link(&self.paths) {
            return self.apply_managed_locked(
                Some(query_exact(&target).map_err(update_error)?),
                false,
                false,
            );
        }
        let status = self.status()?;
        if status.installation.automatic_updates {
            self.apply_package_manager_locked(
                Some(query_exact(&target).map_err(update_error)?),
                status.installation,
                false,
            )
        } else {
            Err(update_error(
                "This Spark installation cannot retry an update automatically",
            ))
        }
    }

    pub fn tick(&mut self) -> Result<UpdateStatus> {
        let status = self.status()?;
        if status.legacy_state {
            return Err(legacy_error());
        }
        let target = status
            .state
            .pending_version
            .as_deref()
            .or(status.state.available_version.as_deref());
        if status.config.policy == UpdatePolicy::Auto
            && target.is_some_and(|target| {
                can_automatically_apply(status.state.current_version.as_deref(), target)
                    && !is_quarantined(&status.state, target)
            })
            && status
                .installation
                .command_path
                .as_deref()
                .is_some_and(|path| self.daemon_is_idle(path))
        {
            return self.apply(target, true);
        }
        self.check(true)
    }

    fn reject_legacy(&self) -> Result<()> {
        if matches!(
            read_state(&self.paths).map_err(update_error)?,
            StateRead::Legacy
        ) {
            Err(legacy_error())
        } else {
            Ok(())
        }
    }

    fn resolve_installation(
        &self,
        managed: bool,
        config: &UpdateConfig,
        version: Option<String>,
    ) -> Installation {
        if managed {
            return Installation {
                method: "managed".to_owned(),
                version,
                command_path: Some(self.paths.launcher_path.clone()),
                update_command: None,
                automatic_updates: true,
                rollback: true,
            };
        }
        if env::var("SPARK_INSTALL_METHOD").ok().as_deref() == Some("container") {
            return Installation {
                method: "container".to_owned(),
                version: Some(self.build_info.version.clone()),
                command_path: self.command_path.clone(),
                update_command: None,
                automatic_updates: false,
                rollback: false,
            };
        }
        let method = detect_package_manager(self.product_root.as_deref());
        let package_method = matches!(method.as_str(), "vp" | "pnpm" | "yarn" | "bun" | "npm");
        let update_command = (package_method && self.command_path.is_some()).then(|| {
            package_manager_command(
                &method,
                config.channel.as_str(),
                self.command_path.as_ref().unwrap(),
            )
            .map(|(command, args)| format_command(&command, &args))
            .unwrap_or_default()
        });
        Installation {
            method,
            version: Some(self.build_info.version.clone()),
            command_path: self.command_path.clone(),
            update_command,
            automatic_updates: package_method && self.command_path.is_some(),
            rollback: package_method && self.command_path.is_some(),
        }
    }

    fn stage_candidate(&self, release: &AvailableRelease) -> Result<BuildInfo> {
        if let Some(requirement) = release.node_requirement.as_deref() {
            assert_node_compatible(requirement)?;
        }
        fs::create_dir_all(&self.paths.staging_dir)
            .map_err(|error| update_error(error.to_string()))?;
        let staging = self.paths.staging_dir.join(format!(
            "{}-{}-{}",
            release.version,
            std::process::id(),
            backup_timestamp()
        ));
        fs::create_dir(&staging).map_err(|error| update_error(error.to_string()))?;
        let download = staging.join("download");
        fs::create_dir(&download).map_err(|error| update_error(error.to_string()))?;
        let pack_args = [
            OsString::from("pack"),
            OsString::from(format!("{PACKAGE_NAME}@{}", release.version)),
            OsString::from("--json"),
            OsString::from("--pack-destination"),
            download.as_os_str().to_os_string(),
            OsString::from("--registry"),
            OsString::from(registry_root()),
        ];
        let packed = run_command(
            OsStr::new("npm"),
            pack_args.iter(),
            Duration::from_secs(120),
        )
        .map_err(update_error)?;
        if packed.code != 0 {
            return Err(update_error(format!(
                "npm pack failed: {}",
                packed.stderr.trim()
            )));
        }
        #[derive(Deserialize)]
        struct PackResult {
            filename: String,
            integrity: String,
        }
        let packed_results: Vec<PackResult> =
            serde_json::from_str(&packed.stdout).map_err(|error| {
                update_error(format!("npm pack returned invalid metadata: {error}"))
            })?;
        let packed_result = packed_results
            .first()
            .ok_or_else(|| update_error("npm pack returned no artifact"))?;
        if packed_result.integrity != release.integrity {
            return Err(update_error(format!(
                "Candidate npm integrity {} does not match registry {}",
                packed_result.integrity, release.integrity
            )));
        }
        let tarball = download.join(&packed_result.filename);
        let install_args = [
            OsString::from("install"),
            OsString::from("--prefix"),
            staging.as_os_str().to_os_string(),
            OsString::from("--omit=dev"),
            OsString::from("--include=optional"),
            OsString::from("--ignore-scripts"),
            OsString::from("--no-package-lock"),
            OsString::from("--no-save"),
            tarball.as_os_str().to_os_string(),
        ];
        let installed = run_command(
            OsStr::new("npm"),
            install_args.iter(),
            Duration::from_secs(180),
        )
        .map_err(update_error)?;
        if installed.code != 0 {
            return Err(update_error(format!(
                "npm install failed: {}",
                installed.stderr.trim()
            )));
        }
        let build_path = staging.join("node_modules/@zendev-lab/spark/dist/build-info.json");
        let build = read_build_info_file(&build_path)?;
        validate_candidate(&build, &release.version)?;
        let binary = installed_native_binary(&staging).map_err(update_error)?;
        if !binary.is_file() {
            return Err(UpdateError::new(
                "NATIVE_PACKAGE_MISSING",
                format!("native payload was not installed at {}", binary.display()),
            ));
        }
        let version_dir = self.paths.versions_dir.join(&release.version);
        fs::create_dir_all(&self.paths.versions_dir)
            .map_err(|error| update_error(error.to_string()))?;
        if version_dir.exists() {
            let existing = self.read_installed_build(&release.version)?;
            if existing.fingerprint != build.fingerprint {
                return Err(update_error(format!(
                    "immutable Spark version directory {} has a different fingerprint",
                    version_dir.display()
                )));
            }
            return Ok(existing);
        }
        fs::rename(&staging, &version_dir).map_err(|error| {
            update_error(format!(
                "failed to commit staged Spark {}: {error}",
                release.version
            ))
        })?;
        Ok(build)
    }

    fn activate_version(&self, version: &str) -> Result<()> {
        exact_version(version)?;
        let target = self.paths.versions_dir.join(version);
        if !target.is_dir() {
            return Err(update_error(format!(
                "Spark version directory is missing: {}",
                target.display()
            )));
        }
        let temporary = self.paths.versions_dir.join(format!(
            ".current-{}-{}",
            std::process::id(),
            backup_timestamp()
        ));
        symlink(version, &temporary).map_err(|error| update_error(error.to_string()))?;
        fs::rename(&temporary, &self.paths.current_link)
            .map_err(|error| update_error(error.to_string()))
    }

    fn write_stable_launcher(&self) -> Result<()> {
        let current = &self.paths.current_link;
        let binary = installed_native_binary(current).map_err(update_error)?;
        let root_package = current.join("node_modules/@zendev-lab/spark");
        let cli_package = current.join("node_modules/@zendev-lab/spark-cli");
        let launcher = format!(
            "#!/bin/sh\nset -eu\nexport SPARK_STABLE_LAUNCHER={}\nexport SPARK_CLI_COMMAND_PATH={}\nexport SPARK_MANAGED_VERSIONS_DIR={}\nexport SPARK_MANAGED_CONFIG_FILE={}\nexport SPARK_MANAGED_STATE_DIR={}\nexport SPARK_MANAGED_CACHE_DIR={}\nexport SPARK_DEPLOYMENT_ROOT={}\nexport SPARK_DEPLOYMENT_WATCH_PATH={}\nexport SPARK_PRODUCT_DIST={}\nexport SPARK_BUILD_INFO_PATH={}\nexport SPARK_DAEMON_COMMAND={}\nexport SPARK_HUB_COMMAND={}\nexport SPARK_ACP_COMMAND={}\nexport SPARK_MCP_COMMAND={}\nexport SPARK_PATHS_COMMAND={}\nexport SPARK_WEB_COMMAND={}\nexport SPARK_WEB_DSH_COMMAND={}\nexec {} \"$@\"\n",
            shell_quote(self.paths.launcher_path.as_os_str()),
            shell_quote(self.paths.launcher_path.as_os_str()),
            shell_quote(self.paths.versions_dir.as_os_str()),
            shell_quote(self.paths.config_file.as_os_str()),
            shell_quote(self.paths.state_dir.as_os_str()),
            shell_quote(self.paths.cache_dir.as_os_str()),
            shell_quote(current.as_os_str()),
            shell_quote(root_package.join("dist/build-info.json").as_os_str()),
            shell_quote(root_package.join("dist").as_os_str()),
            shell_quote(root_package.join("dist/build-info.json").as_os_str()),
            shell_quote(
                current
                    .join("node_modules/@zendev-lab/spark-daemon/bin/spark-daemon")
                    .as_os_str()
            ),
            shell_quote(
                current
                    .join("node_modules/@zendev-lab/spark-hub/bin/spark-hub")
                    .as_os_str()
            ),
            shell_quote(cli_package.join("bin/spark-acp").as_os_str()),
            shell_quote(cli_package.join("bin/spark-mcp").as_os_str()),
            shell_quote(cli_package.join("bin/spark-paths").as_os_str()),
            shell_quote(
                current
                    .join("node_modules/@zendev-lab/spark-web/bin/spark-web")
                    .as_os_str()
            ),
            shell_quote(
                current
                    .join("node_modules/@zendev-lab/spark-web-dsh/bin/spark-web-dsh")
                    .as_os_str()
            ),
            shell_quote(binary.as_os_str()),
        );
        atomic_write(&self.paths.launcher_path, launcher.as_bytes(), 0o755)
            .map_err(update_error)?;
        fs::set_permissions(&self.paths.launcher_path, fs::Permissions::from_mode(0o755))
            .map_err(|error| update_error(error.to_string()))
    }

    fn verify_candidate(&self, build: &BuildInfo, hub: &HubSnapshot) -> Result<()> {
        self.verify_candidate_at(build, &self.paths.launcher_path, hub)
    }

    fn verify_candidate_at(
        &self,
        build: &BuildInfo,
        launcher: &Path,
        hub: &HubSnapshot,
    ) -> Result<()> {
        if cfg!(debug_assertions) && env::var_os("SPARK_UPDATE_SKIP_HEALTH_CHECK").is_some() {
            return Ok(());
        }
        let sync = run_command(
            launcher.as_os_str(),
            ["daemon", "sync", "--wait", "--json"],
            Duration::from_secs(90),
        )
        .map_err(update_error)?;
        if sync.code != 0 {
            return Err(update_error(format!(
                "Daemon handoff failed: {}",
                sync.stderr.trim()
            )));
        }
        let hub_url = self.restart_hub(launcher, hub)?;
        for _ in 0..2 {
            let health = run_command(
                launcher.as_os_str(),
                ["daemon", "status", "--json"],
                Duration::from_secs(30),
            )
            .map_err(update_error)?;
            if health.code != 0 {
                return Err(update_error(format!(
                    "Daemon health check failed: {}",
                    health.stderr.trim()
                )));
            }
            let value = parse_json_output(&health.stdout).map_err(update_error)?;
            let fingerprint = value
                .pointer("/build/runningFingerprint")
                .or_else(|| value.pointer("/status/build/runningFingerprint"))
                .and_then(|value| value.as_str());
            if fingerprint != Some(&build.fingerprint) {
                return Err(update_error(format!(
                    "Daemon health fingerprint {} does not match {}",
                    fingerprint.unwrap_or("missing"),
                    build.fingerprint
                )));
            }
        }
        if let Some(url) = hub_url.or_else(|| env::var("SPARK_HUB_HEALTH_URL").ok()) {
            let mut response = ureq::get(&url)
                .header("accept", "application/json")
                .call()
                .map_err(|error| {
                    update_error(format!("Spark Hub health check failed at {url}: {error}"))
                })?;
            let value: serde_json::Value = response
                .body_mut()
                .read_json()
                .map_err(|error| update_error(error.to_string()))?;
            if value.get("service").and_then(|value| value.as_str()) != Some("spark-hub")
                || value.get("status").and_then(|value| value.as_str()) != Some("ok")
            {
                return Err(update_error(format!(
                    "Spark Hub health check failed at {url}"
                )));
            }
        }
        Ok(())
    }

    fn daemon_is_idle(&self, launcher: &Path) -> bool {
        let result = run_command(
            launcher.as_os_str(),
            ["daemon", "status", "--json"],
            Duration::from_secs(15),
        );
        let Ok(result) = result else { return false };
        if result.code != 0 {
            return false;
        }
        let Ok(value) = parse_json_output(&result.stdout) else {
            return false;
        };
        let running = value
            .pointer("/invocations/running")
            .or_else(|| value.pointer("/status/invocations/running"))
            .and_then(|value| value.as_u64());
        let queued = value
            .pointer("/invocations/queued")
            .or_else(|| value.pointer("/status/invocations/queued"))
            .and_then(|value| value.as_u64());
        running == Some(0) && queued == Some(0)
    }

    fn read_build_from_launcher(&self, launcher: &Path) -> Result<BuildInfo> {
        let result = run_command(
            launcher.as_os_str(),
            ["version", "--json"],
            Duration::from_secs(30),
        )
        .map_err(update_error)?;
        if result.code != 0 {
            return Err(update_error(format!(
                "Updated Spark version check failed: {}",
                result.stderr.trim()
            )));
        }
        serde_json::from_str(&result.stdout).map_err(|error| {
            update_error(format!(
                "Updated Spark returned invalid build metadata: {error}"
            ))
        })
    }

    fn read_installed_build(&self, version: &str) -> Result<BuildInfo> {
        read_build_info_file(
            &self
                .paths
                .versions_dir
                .join(version)
                .join("node_modules/@zendev-lab/spark/dist/build-info.json"),
        )
    }

    fn read_hub_service(&self, launcher: &Path) -> HubSnapshot {
        let result = run_command(
            launcher.as_os_str(),
            ["hub", "web", "status", "--json"],
            Duration::from_secs(15),
        );
        let Ok(result) = result else {
            return HubSnapshot::default();
        };
        if result.code != 0 {
            return HubSnapshot::default();
        }
        let Ok(value) = parse_json_output(&result.stdout) else {
            return HubSnapshot::default();
        };
        HubSnapshot {
            running: value.get("running").and_then(|value| value.as_bool()) == Some(true),
            url: value
                .get("url")
                .and_then(|value| value.as_str())
                .map(str::to_owned),
        }
    }

    fn restart_hub(&self, launcher: &Path, previous: &HubSnapshot) -> Result<Option<String>> {
        if !previous.running {
            return Ok(None);
        }
        for action in ["stop", "start"] {
            let result = run_command(
                launcher.as_os_str(),
                ["hub", "web", action, "--json"],
                Duration::from_secs(30),
            )
            .map_err(update_error)?;
            if result.code != 0 {
                return Err(update_error(format!(
                    "Spark Hub {action} failed: {}",
                    result.stderr.trim()
                )));
            }
            if action == "start" {
                let value = parse_json_output(&result.stdout).map_err(update_error)?;
                if value.get("running").and_then(|value| value.as_bool()) != Some(true) {
                    return Err(update_error(
                        "Spark Hub did not report a running replacement",
                    ));
                }
                return Ok(value
                    .get("url")
                    .and_then(|value| value.as_str())
                    .map(str::to_owned)
                    .or_else(|| previous.url.clone()));
            }
        }
        Ok(previous.url.clone())
    }

    fn restore_package_manager(
        &mut self,
        installation: &Installation,
        version: &str,
        launcher: &Path,
        hub: &HubSnapshot,
    ) -> Result<BuildInfo> {
        let update = package_manager_command(&installation.method, version, launcher)?;
        let result = run_command(&update.0, update.1.iter(), Duration::from_secs(120))
            .map_err(update_error)?;
        if result.code != 0 {
            return Err(update_error(format!(
                "{} rollback failed: {}",
                installation.method,
                result.stderr.trim()
            )));
        }
        let build = self.read_build_from_launcher(launcher)?;
        if build.version != version {
            return Err(update_error(format!(
                "{} restored Spark {}, expected {version}",
                installation.method, build.version
            )));
        }
        self.verify_candidate_at(&build, launcher, hub)?;
        self.build_info = build.clone();
        Ok(build)
    }

    fn quarantine_and_fail(
        &self,
        state: &mut UpdateState,
        version: &str,
        code: &str,
        message: &str,
    ) -> Result<()> {
        state.quarantined.retain(|entry| entry.version != version);
        state.quarantined.push(QuarantinedVersion {
            version: version.to_owned(),
            reason: message.to_owned(),
            quarantined_at: now_rfc3339(),
        });
        self.record_failure(state, code, message, Some(version))
    }

    fn record_failure(
        &self,
        state: &mut UpdateState,
        code: &str,
        message: &str,
        version: Option<&str>,
    ) -> Result<()> {
        let same = state
            .failure
            .as_ref()
            .is_some_and(|failure| failure.code == code && failure.version.as_deref() == version);
        let count = if same {
            state.failure.as_ref().unwrap().count + 1
        } else {
            1
        };
        let now = now_rfc3339();
        state.failure = Some(UpdateFailure {
            version: version.map(str::to_owned),
            code: code.to_owned(),
            message: message.to_owned(),
            count,
            first_at: if same {
                state.failure.as_ref().unwrap().first_at.clone()
            } else {
                now.clone()
            },
            last_at: now.clone(),
            next_retry_at: rfc3339_after_minutes(
                [30, 120, 360, 1_440][usize::min(count.saturating_sub(1) as usize, 3)],
            ),
            last_logged_at: Some(now),
            last_notified_at: state
                .failure
                .as_ref()
                .and_then(|failure| failure.last_notified_at.clone()),
        });
        write_state(&self.paths, state).map_err(update_error)
    }

    fn install_macos_updater_job(&self, config: &UpdateConfig) -> Result<()> {
        if env::consts::OS != "macos" {
            return Ok(());
        }
        let disabled = config.policy == UpdatePolicy::Manual;
        if disabled {
            if self.paths.updater_launch_agent_path.exists() {
                let _ = run_command(
                    OsStr::new("launchctl"),
                    [
                        "bootout",
                        &format!("gui/{}", current_uid()),
                        self.paths
                            .updater_launch_agent_path
                            .to_string_lossy()
                            .as_ref(),
                    ],
                    Duration::from_secs(15),
                );
            }
            return Ok(());
        }
        let launcher = self.status()?.installation.command_path.ok_or_else(|| {
            update_error(
                "Background updates require a managed or globally installed Spark command on PATH",
            )
        })?;
        let path = env::var("PATH").unwrap_or_default();
        let updater_path = format!(
            "{}:{path}",
            launcher
                .parent()
                .unwrap_or_else(|| Path::new("/usr/bin"))
                .display()
        );
        let plist = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>dev.spark.updater</string><key>ProgramArguments</key><array><string>{}</string><string>update</string><string>__tick</string></array><key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string></dict><key>StartInterval</key><integer>900</integer><key>RunAtLoad</key><true/><key>ProcessType</key><string>Background</string></dict></plist>\n",
            xml_escape(&launcher.to_string_lossy()),
            xml_escape(&updater_path)
        );
        atomic_write(
            &self.paths.updater_launch_agent_path,
            plist.as_bytes(),
            0o600,
        )
        .map_err(update_error)?;
        let domain = format!("gui/{}", current_uid());
        let _ = run_command(
            OsStr::new("launchctl"),
            [
                "bootout",
                &domain,
                self.paths
                    .updater_launch_agent_path
                    .to_string_lossy()
                    .as_ref(),
            ],
            Duration::from_secs(15),
        );
        let loaded = run_command(
            OsStr::new("launchctl"),
            [
                "bootstrap",
                &domain,
                self.paths
                    .updater_launch_agent_path
                    .to_string_lossy()
                    .as_ref(),
            ],
            Duration::from_secs(15),
        )
        .map_err(update_error)?;
        if loaded.code != 0 {
            return Err(update_error(format!(
                "Failed to register Spark updater launchd job: {}",
                loaded.stderr.trim()
            )));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default)]
pub struct ConfigureChange {
    pub policy: Option<UpdatePolicy>,
    pub channel: Option<UpdateChannel>,
    pub check_interval_hours: Option<u32>,
}

#[derive(Clone, Debug, Default)]
struct HubSnapshot {
    running: bool,
    url: Option<String>,
}

struct LegacyBackup {
    root: PathBuf,
    moved: Vec<(PathBuf, PathBuf)>,
}

impl LegacyBackup {
    fn create(paths: &UpdatePaths) -> Result<Self> {
        let root = paths
            .backups_dir
            .join(format!("legacy-{}", backup_timestamp()));
        fs::create_dir_all(&root).map_err(|error| {
            update_error(format!(
                "failed to create legacy backup {}: {error}",
                root.display()
            ))
        })?;
        let candidates = [
            (&paths.versions_dir, root.join("versions")),
            (&paths.state_file, root.join("state.json")),
            (&paths.launcher_path, root.join("launcher")),
        ];
        let mut moved = Vec::new();
        for (source, destination) in candidates {
            if !source.exists() {
                continue;
            }
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| update_error(error.to_string()))?;
            }
            if let Err(error) = fs::rename(source, &destination) {
                for (original, backup) in moved.iter().rev() {
                    let _ = fs::rename(backup, original);
                }
                return Err(update_error(format!(
                    "failed to back up {}: {error}",
                    source.display()
                )));
            }
            moved.push((source.clone(), destination));
        }
        Ok(Self { root, moved })
    }

    fn restore(&mut self, paths: &UpdatePaths) -> Result<()> {
        let failed = self
            .root
            .join(format!("failed-native-{}", backup_timestamp()));
        fs::create_dir_all(&failed).map_err(|error| update_error(error.to_string()))?;
        for (path, name) in [
            (&paths.versions_dir, "versions"),
            (&paths.state_file, "state.json"),
            (&paths.launcher_path, "launcher"),
        ] {
            if path.exists() {
                fs::rename(path, failed.join(name)).map_err(|error| {
                    update_error(format!(
                        "failed to retain failed native path {}: {error}",
                        path.display()
                    ))
                })?;
            }
        }
        for (original, backup) in self.moved.iter().rev() {
            if backup.exists() {
                if let Some(parent) = original.parent() {
                    fs::create_dir_all(parent).map_err(|error| update_error(error.to_string()))?;
                }
                fs::rename(backup, original).map_err(|error| {
                    update_error(format!("failed to restore {}: {error}", original.display()))
                })?;
            }
        }
        Ok(())
    }
}

pub fn read_build_info() -> Result<BuildInfo> {
    let candidates = [
        env::var_os("SPARK_BUILD_INFO_PATH").map(PathBuf::from),
        env::var_os("SPARK_PRODUCT_DIST")
            .map(PathBuf::from)
            .map(|path| path.join("build-info.json")),
        env::current_dir()
            .ok()
            .map(|path| path.join("dist/build-info.json")),
    ];
    for candidate in candidates.into_iter().flatten() {
        if candidate.is_file() {
            return read_build_info_file(&candidate);
        }
    }
    let version = env!("CARGO_PKG_VERSION").to_owned();
    let git_sha = option_env!("SPARK_BUILD_GIT_SHA")
        .unwrap_or("source-checkout")
        .to_owned();
    let migration_head = "source-checkout".to_owned();
    let fingerprint = build_fingerprint(&version, &git_sha, PROTOCOL_VERSION, &migration_head);
    Ok(BuildInfo {
        schema_version: 1,
        package_name: PACKAGE_NAME.to_owned(),
        version,
        git_sha,
        protocol_version: PROTOCOL_VERSION,
        minimum_node_version: ">=24.0.0".to_owned(),
        migration_head,
        migration_mode: "manual".to_owned(),
        deployment_generation: Some(2),
        fingerprint,
    })
}

fn read_build_info_file(path: &Path) -> Result<BuildInfo> {
    let source = fs::read_to_string(path)
        .map_err(|error| update_error(format!("failed to read {}: {error}", path.display())))?;
    serde_json::from_str(&source).map_err(|error| {
        update_error(format!(
            "invalid Spark build-info {}: {error}",
            path.display()
        ))
    })
}

fn build_fingerprint(version: &str, git_sha: &str, protocol: u32, migration_head: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(format!(
        "{version}\n{git_sha}\n{protocol}\n{migration_head}"
    ));
    format!("sha256:{:x}", hash.finalize())
}

fn validate_candidate(build: &BuildInfo, version: &str) -> Result<()> {
    if build.schema_version != 1
        || build.version != version
        || build.protocol_version != PROTOCOL_VERSION
        || build.deployment_generation != Some(2)
        || !matches!(build.migration_mode.as_str(), "manual" | "expand-only")
    {
        return Err(update_error(format!(
            "Spark {version} does not declare a compatible native deployment generation"
        )));
    }
    assert_node_compatible(&build.minimum_node_version)
}

fn managed_current_link(paths: &UpdatePaths) -> bool {
    fs::symlink_metadata(&paths.current_link)
        .is_ok_and(|metadata| metadata.file_type().is_symlink())
}

fn exact_version(version: &str) -> Result<Version> {
    Version::parse(version).map_err(|_| {
        update_error(format!(
            "Expected an exact semantic version, received: {version}"
        ))
    })
}

pub fn can_automatically_apply(current: Option<&str>, target: &str) -> bool {
    let Ok(target) = Version::parse(target) else {
        return false;
    };
    let Some(current) = current.and_then(|value| Version::parse(value).ok()) else {
        return true;
    };
    if current.major == 0 && current.minor != target.minor {
        return false;
    }
    target > current
}

fn is_quarantined(state: &UpdateState, version: &str) -> bool {
    state
        .quarantined
        .iter()
        .any(|entry| entry.version == version)
}

fn network_check_due(config: &UpdateConfig, state: &UpdateState) -> bool {
    let Some(last_check) = state.last_check_at.as_deref() else {
        return true;
    };
    if let Some(failure) = state.failure.as_ref()
        && failure.next_retry_at.as_str() > now_rfc3339().as_str()
    {
        return false;
    }
    let Ok(last) = parse_rfc3339_seconds(last_check) else {
        return true;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    now >= last.saturating_add(config.check_interval_hours as u64 * 3_600)
}

fn parse_rfc3339_seconds(value: &str) -> std::result::Result<u64, ()> {
    // Timestamp comparison only needs the updater's own fixed-width UTC form.
    if value.len() != 20 || !value.ends_with('Z') {
        return Err(());
    }
    let year: i32 = value[0..4].parse().map_err(|_| ())?;
    let month: u32 = value[5..7].parse().map_err(|_| ())?;
    let day: u32 = value[8..10].parse().map_err(|_| ())?;
    let hour: u32 = value[11..13].parse().map_err(|_| ())?;
    let minute: u32 = value[14..16].parse().map_err(|_| ())?;
    let second: u32 = value[17..19].parse().map_err(|_| ())?;
    let days = days_from_civil(year, month, day);
    Ok((days * 86_400 + hour as i64 * 3_600 + minute as i64 * 60 + second as i64) as u64)
}

fn days_from_civil(year: i32, month: u32, day: u32) -> i64 {
    let year = year as i64 - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let month_prime = month as i64 + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * month_prime + 2) / 5 + day as i64 - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn assert_node_compatible(requirement: &str) -> Result<()> {
    let output = run_command(OsStr::new("node"), ["--version"], Duration::from_secs(10))
        .map_err(update_error)?;
    if output.code != 0 {
        return Err(update_error(
            "Node.js is required for Spark managed installations",
        ));
    }
    let current = output
        .stdout
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or_else(|| update_error("Could not identify the installed Node.js version"))?;
    let minimum = requirement
        .split(">=")
        .nth(1)
        .and_then(|value| {
            value
                .split(|character: char| !character.is_ascii_digit())
                .next()
        })
        .and_then(|value| value.parse::<u32>().ok());
    let maximum = requirement
        .split('<')
        .nth(1)
        .and_then(|value| {
            value
                .split(|character: char| !character.is_ascii_digit())
                .next()
        })
        .and_then(|value| value.parse::<u32>().ok());
    if minimum.is_some_and(|minimum| current < minimum)
        || maximum.is_some_and(|maximum| current >= maximum)
    {
        return Err(update_error(format!(
            "Spark requires Node {requirement}; current Node is {current}"
        )));
    }
    Ok(())
}

fn detect_package_manager(product_root: Option<&Path>) -> String {
    let Some(root) = product_root else {
        return "source".to_owned();
    };
    let normalized = root.to_string_lossy().replace('\\', "/").to_lowercase();
    if normalized.contains("/.vite-plus/packages/") {
        "vp"
    } else if normalized.contains("/.pnpm/") || normalized.contains("/pnpm/global/") {
        "pnpm"
    } else if normalized.contains("/.yarn/") || normalized.contains("/yarn/global/") {
        "yarn"
    } else if normalized.contains("/.bun/install/global/node_modules/") {
        "bun"
    } else if normalized.contains("/node_modules/") {
        "npm"
    } else {
        "unknown"
    }
    .to_owned()
}

fn package_manager_command(
    method: &str,
    target: &str,
    spark_path: &Path,
) -> Result<(OsString, Vec<OsString>)> {
    let command = spark_path
        .parent()
        .map(|parent| parent.join(method))
        .filter(|path| path.exists())
        .map(|path| path.into_os_string())
        .unwrap_or_else(|| OsString::from(method));
    let spec = format!("{PACKAGE_NAME}@{target}");
    let args: Vec<OsString> = match method {
        "yarn" => ["global", "add", "--ignore-scripts"]
            .into_iter()
            .map(OsString::from)
            .chain([OsString::from(spec)])
            .collect(),
        "bun" => [
            "install",
            "-g",
            "--ignore-scripts",
            "--minimum-release-age=0",
        ]
        .into_iter()
        .map(OsString::from)
        .chain([OsString::from(spec)])
        .collect(),
        "pnpm" => [
            "install",
            "-g",
            "--ignore-scripts",
            "--config.minimumReleaseAge=0",
        ]
        .into_iter()
        .map(OsString::from)
        .chain([OsString::from(spec)])
        .collect(),
        "npm" | "vp" => ["install", "-g", "--ignore-scripts"]
            .into_iter()
            .map(OsString::from)
            .chain([OsString::from(spec)])
            .collect(),
        _ => {
            return Err(update_error(format!(
                "Unsupported Spark package manager: {method}"
            )));
        }
    };
    Ok((command, args))
}

fn format_command(command: &OsStr, args: &[OsString]) -> String {
    std::iter::once(command)
        .chain(args.iter().map(OsString::as_os_str))
        .map(shell_quote)
        .collect::<Vec<_>>()
        .join(" ")
}

fn find_spark_on_path() -> Option<PathBuf> {
    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|directory| directory.join("spark"))
            .find(|candidate| candidate.is_file())
    })
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn current_uid() -> u32 {
    env::var("UID")
        .ok()
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_paths(label: &str) -> UpdatePaths {
        let root = env::temp_dir().join(format!(
            "spark-deployment-manager-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        UpdatePaths {
            versions_dir: root.join("versions"),
            current_link: root.join("versions/current"),
            config_file: root.join("config/update.toml"),
            state_dir: root.join("state"),
            state_file: root.join("state/state.json"),
            lock_file: root.join("state/update.lock"),
            cache_dir: root.join("cache"),
            staging_dir: root.join("cache/staging"),
            launcher_path: root.join("bin/spark"),
            updater_launch_agent_path: root.join("updater.plist"),
            backups_dir: root.join("backups"),
        }
    }

    fn fixture_build(fingerprint: &str) -> BuildInfo {
        BuildInfo {
            schema_version: 1,
            package_name: PACKAGE_NAME.to_owned(),
            version: "0.5.0".to_owned(),
            git_sha: "fixture".to_owned(),
            protocol_version: PROTOCOL_VERSION,
            minimum_node_version: ">=24.0.0".to_owned(),
            migration_head: "fixture.sql".to_owned(),
            migration_mode: "manual".to_owned(),
            deployment_generation: Some(2),
            fingerprint: fingerprint.to_owned(),
        }
    }

    fn fixture_manager(paths: UpdatePaths, build: BuildInfo) -> Manager {
        Manager {
            paths,
            build_info: build,
            command_path: None,
            product_root: None,
        }
    }

    #[test]
    fn automatic_updates_stop_at_zero_x_minor_boundary() {
        assert!(can_automatically_apply(Some("0.5.0"), "0.5.1"));
        assert!(!can_automatically_apply(Some("0.4.9"), "0.5.0"));
        assert!(!can_automatically_apply(Some("0.5.1"), "0.5.0"));
        assert!(can_automatically_apply(None, "0.5.0"));
    }

    #[test]
    fn parses_native_timestamps_for_check_fences() {
        assert_eq!(parse_rfc3339_seconds("1970-01-01T00:00:00Z"), Ok(0));
        assert!(parse_rfc3339_seconds("invalid").is_err());
    }

    #[test]
    fn legacy_backup_restores_every_owned_path_and_preserves_config() {
        let paths = temporary_paths("legacy-restore");
        fs::create_dir_all(paths.versions_dir.join("0.4.0")).unwrap();
        fs::create_dir_all(paths.state_file.parent().unwrap()).unwrap();
        fs::create_dir_all(paths.launcher_path.parent().unwrap()).unwrap();
        fs::create_dir_all(paths.config_file.parent().unwrap()).unwrap();
        fs::write(paths.versions_dir.join("0.4.0/payload"), "old-version").unwrap();
        fs::write(&paths.state_file, "old-state").unwrap();
        fs::write(&paths.launcher_path, "old-launcher").unwrap();
        fs::write(&paths.config_file, "policy = \"manual\"\n").unwrap();

        let mut backup = LegacyBackup::create(&paths).unwrap();
        assert!(!paths.versions_dir.exists());
        assert!(!paths.state_file.exists());
        assert!(!paths.launcher_path.exists());
        assert_eq!(
            fs::read_to_string(&paths.config_file).unwrap(),
            "policy = \"manual\"\n"
        );
        fs::create_dir_all(&paths.versions_dir).unwrap();
        fs::create_dir_all(paths.state_file.parent().unwrap()).unwrap();
        fs::create_dir_all(paths.launcher_path.parent().unwrap()).unwrap();
        fs::write(paths.versions_dir.join("failed"), "new-version").unwrap();
        fs::write(&paths.state_file, "new-state").unwrap();
        fs::write(&paths.launcher_path, "new-launcher").unwrap();

        backup.restore(&paths).unwrap();
        assert_eq!(
            fs::read_to_string(paths.versions_dir.join("0.4.0/payload")).unwrap(),
            "old-version"
        );
        assert_eq!(fs::read_to_string(&paths.state_file).unwrap(), "old-state");
        assert_eq!(
            fs::read_to_string(&paths.launcher_path).unwrap(),
            "old-launcher"
        );
        let failed = fs::read_dir(&backup.root)
            .unwrap()
            .filter_map(std::result::Result::ok)
            .find(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("failed-native-")
            })
            .unwrap()
            .path();
        assert_eq!(
            fs::read_to_string(failed.join("state.json")).unwrap(),
            "new-state"
        );
    }

    #[test]
    fn health_fence_requires_two_matching_daemon_fingerprints() {
        let paths = temporary_paths("health-fence");
        fs::create_dir_all(paths.launcher_path.parent().unwrap()).unwrap();
        let fingerprint = "sha256:fixture-health";
        fs::write(
            &paths.launcher_path,
            format!(
                "#!/bin/sh\ncase \"$1 $2\" in\n  'daemon sync') printf '{{}}\\n' ;;\n  'daemon status') printf '{{\"build\":{{\"runningFingerprint\":\"{fingerprint}\"}}}}\\n' ;;\n  *) exit 2 ;;\nesac\n"
            ),
        )
        .unwrap();
        fs::set_permissions(&paths.launcher_path, fs::Permissions::from_mode(0o755)).unwrap();
        let build = fixture_build(fingerprint);
        let manager = fixture_manager(paths.clone(), build.clone());
        manager
            .verify_candidate_at(&build, &paths.launcher_path, &HubSnapshot::default())
            .unwrap();

        let mismatch = fixture_build("sha256:different");
        assert!(
            manager
                .verify_candidate_at(&mismatch, &paths.launcher_path, &HubSnapshot::default())
                .unwrap_err()
                .message
                .contains("does not match")
        );
    }

    #[test]
    fn quarantine_records_backoff_and_suppresses_the_candidate() {
        let paths = temporary_paths("quarantine");
        let manager = fixture_manager(paths.clone(), fixture_build("sha256:fixture"));
        let mut state = UpdateState::default();
        manager
            .quarantine_and_fail(&mut state, "0.5.1", "health_failed", "fingerprint mismatch")
            .unwrap();
        assert!(is_quarantined(&state, "0.5.1"));
        assert_eq!(state.failure.as_ref().unwrap().count, 1);
        let first_retry = state.failure.as_ref().unwrap().next_retry_at.clone();
        manager
            .quarantine_and_fail(&mut state, "0.5.1", "health_failed", "fingerprint mismatch")
            .unwrap();
        assert_eq!(state.quarantined.len(), 1);
        assert_eq!(state.failure.as_ref().unwrap().count, 2);
        assert!(state.failure.as_ref().unwrap().next_retry_at > first_retry);
    }

    #[test]
    fn package_manager_commands_are_exact_and_ignore_scripts() {
        let spark = Path::new("/tmp/spark-package-manager/bin/spark");
        let (command, args) = package_manager_command("npm", "0.5.1", spark).unwrap();
        assert_eq!(command, OsString::from("npm"));
        assert_eq!(
            args,
            [
                "install",
                "-g",
                "--ignore-scripts",
                "@zendev-lab/spark@0.5.1"
            ]
            .map(OsString::from)
        );
        assert!(package_manager_command("unknown", "0.5.1", spark).is_err());
    }

    #[test]
    fn managed_launcher_executes_native_and_exports_the_deployment_watch_path() {
        let paths = temporary_paths("launcher");
        let manager = fixture_manager(paths.clone(), fixture_build("sha256:fixture"));
        manager.write_stable_launcher().unwrap();
        let launcher = fs::read_to_string(&paths.launcher_path).unwrap();
        assert!(launcher.contains("SPARK_DEPLOYMENT_WATCH_PATH="));
        assert!(launcher.contains("SPARK_DAEMON_COMMAND="));
        assert!(launcher.contains("exec "));
        assert!(!launcher.contains("node "));
    }
}
