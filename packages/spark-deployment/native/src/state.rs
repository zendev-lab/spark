use crate::model::{
    DEPLOYMENT_GENERATION, STATE_SCHEMA_VERSION, UpdateConfig, UpdatePaths, UpdateState,
};
use crate::util::backup_timestamp;
use serde_json::Value;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{ErrorKind, Seek, SeekFrom, Write};
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum StateRead {
    Native(Box<UpdateState>),
    Legacy,
}

pub fn read_state(paths: &UpdatePaths) -> Result<StateRead, String> {
    let source = match fs::read_to_string(&paths.state_file) {
        Ok(source) => source,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(StateRead::Native(Box::default()));
        }
        Err(error) => {
            return Err(format!(
                "failed to read {}: {error}",
                paths.state_file.display()
            ));
        }
    };
    let value: Value = serde_json::from_str(&source).map_err(|error| {
        format!(
            "invalid updater state at {}: {error}",
            paths.state_file.display()
        )
    })?;
    let schema = value.get("schemaVersion").and_then(Value::as_u64);
    if schema == Some(1) {
        return Ok(StateRead::Legacy);
    }
    if schema != Some(STATE_SCHEMA_VERSION.into())
        || value.get("generation").and_then(Value::as_str) != Some(DEPLOYMENT_GENERATION)
    {
        return Err(format!(
            "unsupported updater state at {}: expected schemaVersion 2 and generation native",
            paths.state_file.display()
        ));
    }
    serde_json::from_value(value)
        .map(|state| StateRead::Native(Box::new(state)))
        .map_err(|error| {
            format!(
                "invalid updater state at {}: {error}",
                paths.state_file.display()
            )
        })
}

pub fn native_state(paths: &UpdatePaths) -> Result<UpdateState, String> {
    match read_state(paths)? {
        StateRead::Native(state) => Ok(*state),
        StateRead::Legacy => Err("LEGACY_MANAGED_INSTALL".to_owned()),
    }
}

pub fn write_state(paths: &UpdatePaths, state: &UpdateState) -> Result<(), String> {
    if state.schema_version != STATE_SCHEMA_VERSION || state.generation != DEPLOYMENT_GENERATION {
        return Err("refusing to write non-native Spark updater state".to_owned());
    }
    atomic_write_json(&paths.state_file, state)
}

pub fn read_config(paths: &UpdatePaths) -> Result<UpdateConfig, String> {
    let mut config = match fs::read_to_string(&paths.config_file) {
        Ok(source) => toml::from_str::<UpdateConfig>(&source)
            .map_err(|error| format!("invalid {}: {error}", paths.config_file.display()))?,
        Err(error) if error.kind() == ErrorKind::NotFound => UpdateConfig::default(),
        Err(error) => {
            return Err(format!(
                "failed to read {}: {error}",
                paths.config_file.display()
            ));
        }
    };
    if let Ok(value) = std::env::var("SPARK_UPDATE_POLICY") {
        config.policy = toml::from_str(&format!("value = \"{value}\""))
            .ok()
            .and_then(|value: toml::Value| value.get("value").cloned())
            .and_then(|value| value.try_into().ok())
            .ok_or_else(|| format!("Invalid SPARK_UPDATE_POLICY: {value}"))?;
    }
    if let Ok(value) = std::env::var("SPARK_UPDATE_CHANNEL") {
        config.channel = toml::from_str(&format!("value = \"{value}\""))
            .ok()
            .and_then(|value: toml::Value| value.get("value").cloned())
            .and_then(|value| value.try_into().ok())
            .ok_or_else(|| format!("Invalid SPARK_UPDATE_CHANNEL: {value}"))?;
    }
    validate_config(&config)?;
    Ok(config)
}

pub fn write_config(paths: &UpdatePaths, config: &UpdateConfig) -> Result<(), String> {
    validate_config(config)?;
    let source = toml::to_string(config).map_err(|error| error.to_string())?;
    atomic_write(&paths.config_file, source.as_bytes(), 0o600)
}

fn validate_config(config: &UpdateConfig) -> Result<(), String> {
    if !(1..=168).contains(&config.check_interval_hours) {
        return Err("checkIntervalHours must be between 1 and 168".to_owned());
    }
    Ok(())
}

fn atomic_write_json(path: &Path, value: &impl serde::Serialize) -> Result<(), String> {
    let mut source = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    source.push(b'\n');
    atomic_write(path, &source, 0o600)
}

pub fn atomic_write(path: &Path, source: &[u8], mode: u32) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("failed to create {}: {error}", parent.display()))?;
    let temporary = path.with_extension(format!(
        "{}.{}.tmp",
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("file"),
        backup_timestamp()
    ));
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(mode);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("failed to create {}: {error}", temporary.display()))?;
    file.write_all(source)
        .map_err(|error| format!("failed to write {}: {error}", temporary.display()))?;
    file.sync_all()
        .map_err(|error| format!("failed to sync {}: {error}", temporary.display()))?;
    fs::rename(&temporary, path)
        .map_err(|error| format!("failed to replace {}: {error}", path.display()))
}

#[derive(Debug)]
pub struct UpdateLock {
    _file: File,
}

impl UpdateLock {
    pub fn acquire(paths: &UpdatePaths) -> Result<Self, String> {
        if let Some(parent) = paths.lock_file.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut options = OpenOptions::new();
        options.create(true).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&paths.lock_file)
            .map_err(|error| error.to_string())?;
        match file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => {
                return Err(format!(
                    "Another Spark update is already running ({})",
                    paths.lock_file.display()
                ));
            }
            Err(TryLockError::Error(error)) => {
                return Err(format!(
                    "failed to lock {}: {error}",
                    paths.lock_file.display()
                ));
            }
        }
        file.set_len(0).map_err(|error| error.to_string())?;
        file.seek(SeekFrom::Start(0))
            .map_err(|error| error.to_string())?;
        file.write_all(format!("{}\n", std::process::id()).as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        Ok(Self { _file: file })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_paths() -> UpdatePaths {
        let root = std::env::temp_dir().join(format!(
            "spark-deployment-state-{}-{}",
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

    #[test]
    fn rejects_legacy_state_for_native_writes() {
        let paths = temporary_paths();
        fs::create_dir_all(paths.state_file.parent().unwrap()).unwrap();
        fs::write(
            &paths.state_file,
            "{\"schemaVersion\":1,\"quarantined\":[]}\n",
        )
        .unwrap();
        assert_eq!(read_state(&paths).unwrap(), StateRead::Legacy);
        assert_eq!(native_state(&paths).unwrap_err(), "LEGACY_MANAGED_INSTALL");
    }

    #[test]
    fn atomically_round_trips_native_state_and_locks() {
        let paths = temporary_paths();
        let state = UpdateState::default();
        write_state(&paths, &state).unwrap();
        assert_eq!(
            read_state(&paths).unwrap(),
            StateRead::Native(Box::new(state))
        );
        let lock = UpdateLock::acquire(&paths).unwrap();
        assert!(
            UpdateLock::acquire(&paths)
                .unwrap_err()
                .contains("already running")
        );
        drop(lock);
        assert!(UpdateLock::acquire(&paths).is_ok());
    }

    #[test]
    fn replaces_a_stale_lock_without_stealing_a_live_lock() {
        let paths = temporary_paths();
        fs::create_dir_all(paths.lock_file.parent().unwrap()).unwrap();
        fs::write(&paths.lock_file, "4294967295\n").unwrap();
        let lock = UpdateLock::acquire(&paths).unwrap();
        assert_eq!(
            fs::read_to_string(&paths.lock_file).unwrap(),
            format!("{}\n", std::process::id())
        );
        assert!(UpdateLock::acquire(&paths).is_err());
        drop(lock);
        assert!(UpdateLock::acquire(&paths).is_ok());
        assert!(paths.lock_file.exists());
    }
}
