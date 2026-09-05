use bpaf::{Parser, construct, long};
use serde::Deserialize;
use spark_deployment::{
    ConfigureChange, Manager, ManagerOptions, UpdateChannel, UpdateError, UpdatePolicy,
    UpdateStatus,
};
use std::env;
use std::ffi::OsString;
use std::io::{self, IsTerminal};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

const HELP: &str = r#"spark - Spark native command router

Usage:
  spark
  spark run [--json] [--wait] [--resume <session>] <prompt>
  spark bg [--session <id>] [--json] <prompt>
  spark paths [--json]
  spark doctor
  spark install --managed [--version <version>] [--prefix <path>]
  spark update status|check|apply|rollback|retry|configure
  spark version [--json]
  spark daemon <command> [args...]
  spark hub [command] [args...]
  spark acp
  spark mcp
  spark web [--host 127.0.0.1] [--port 4310]
  spark --help
  spark --version

The native CLI owns root parsing, diagnostics, routing, and deployment updates.
Daemon execution, Hub coordination, ACP/MCP, and Web remain Node companions.
"#;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Catalog {
    schema_version: u32,
    diagnostics: std::collections::BTreeMap<String, Diagnostic>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Diagnostic {
    code: String,
    title: String,
    description: Option<String>,
    #[serde(default)]
    hints: Vec<String>,
    exit_code: i32,
}

fn catalog() -> Catalog {
    serde_json::from_str(include_str!(
        "../../../../packages/spark-i18n/src/cli-diagnostics.json"
    ))
    .expect("Spark CLI diagnostic catalog must be valid")
}

fn diagnostic(code: &str) -> Diagnostic {
    let catalog = catalog();
    assert_eq!(
        catalog.schema_version, 1,
        "unsupported CLI diagnostic catalog"
    );
    catalog
        .diagnostics
        .get(code)
        .cloned()
        .unwrap_or_else(|| Diagnostic {
            code: code.to_owned(),
            title: "Spark command failed".to_owned(),
            description: None,
            hints: Vec::new(),
            exit_code: 1,
        })
}

fn print_diagnostic(
    code: &str,
    title: Option<&str>,
    detail: Option<&str>,
    extra_hints: &[String],
) -> i32 {
    let descriptor = diagnostic(code);
    let color = io::stderr().is_terminal() && env::var_os("NO_COLOR").is_none();
    let prefix = if color {
        "\x1b[1;31merror\x1b[0m"
    } else {
        "error"
    };
    eprintln!(
        "{prefix} [{}]: {}",
        descriptor.code,
        title.unwrap_or(&descriptor.title)
    );
    if let Some(description) = descriptor.description {
        for line in description.lines().filter(|line| !line.trim().is_empty()) {
            eprintln!("  {}", line.trim());
        }
    }
    for hint in descriptor.hints.iter().chain(extra_hints) {
        eprintln!("hint: {}", hint.trim());
    }
    if let Some(detail) = detail.filter(|value| !value.trim().is_empty()) {
        eprintln!("details: {}", detail.trim());
    }
    descriptor.exit_code
}

fn main() {
    let args: Vec<OsString> = env::args_os().skip(1).collect();
    let code = match run(args) {
        Ok(code) => code,
        Err(error) => print_diagnostic(error.code, None, Some(&error.message), &[]),
    };
    if code != 0 {
        std::process::exit(code);
    }
}

fn run(args: Vec<OsString>) -> Result<i32, UpdateError> {
    let first = args.first().and_then(|value| value.to_str());
    match first {
        None | Some("help" | "--help" | "-h") => {
            print!("{HELP}");
            Ok(0)
        }
        Some("version") => run_version(&args[1..]),
        Some("--version" | "-v") => run_version(&[]),
        Some("install") => run_install(&args[1..]),
        Some("update") => run_update(&args[1..]),
        Some("run") => exec_target(Target::Daemon, map_run_args(&args[1..], "spark-run")?),
        Some("bg") => exec_target(Target::Daemon, map_run_args(&args[1..], "spark-bg")?),
        Some("paths") => exec_target(Target::Paths, args[1..].to_vec()),
        Some("doctor") => {
            let mut forwarded = vec![OsString::from("doctor")];
            forwarded.extend_from_slice(&args[1..]);
            exec_target(Target::Daemon, forwarded)
        }
        Some("daemon") => exec_target(Target::Daemon, args[1..].to_vec()),
        Some("hub") => exec_target(Target::Hub, args[1..].to_vec()),
        Some("acp") => exec_target(Target::Acp, args[1..].to_vec()),
        Some("mcp") => exec_target(Target::Mcp, args[1..].to_vec()),
        Some("web") => exec_target(Target::Web, args[1..].to_vec()),
        Some("tui" | "server") => Ok(print_diagnostic("COMMAND_REMOVED", None, first, &[])),
        Some("web-dsh") => Ok(print_diagnostic(
            "COMMAND_REMOVED",
            None,
            first,
            &["Use \"spark web\" for the local browser workbench.".to_owned()],
        )),
        Some(command) => Ok(print_diagnostic(
            "UNKNOWN_COMMAND",
            Some(&format!("Unknown Spark command: {command}")),
            None,
            &[
                "Use \"spark web\" for the browser workbench or \"spark run <prompt>\" for a headless turn."
                    .to_owned(),
            ],
        )),
    }
}

fn run_version(args: &[OsString]) -> Result<i32, UpdateError> {
    let json = match args {
        [] => false,
        [flag] if flag == "--json" => true,
        _ => {
            return Ok(print_diagnostic(
                "INVALID_ARGUMENT",
                Some("Invalid spark version options"),
                None,
                &["The command accepts only the optional --json flag.".to_owned()],
            ));
        }
    };
    let manager = Manager::new(ManagerOptions::default())?;
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(manager.build_info())
                .map_err(|error| UpdateError::new("UPDATE_FAILED", error.to_string()))?
        );
    } else {
        println!("{}", manager.build_info().version);
    }
    Ok(0)
}

fn run_install(args: &[OsString]) -> Result<i32, UpdateError> {
    if !args.iter().any(|argument| argument == "--managed") {
        return Ok(print_diagnostic(
            "INVALID_ARGUMENT",
            Some("spark install requires --managed"),
            None,
            &[],
        ));
    }
    let version = option_value(args, "--version")?;
    let prefix = option_value(args, "--prefix")?.map(PathBuf::from);
    let allowed = ["--managed", "--version", "--prefix"];
    if let Some(unknown) = unknown_options(args, &allowed, &["--version", "--prefix"]) {
        return Ok(print_diagnostic(
            "INVALID_ARGUMENT",
            Some("Unknown managed install option"),
            Some(&unknown.to_string_lossy()),
            &[],
        ));
    }
    let mut manager = Manager::new(ManagerOptions {
        prefix,
        ..ManagerOptions::default()
    })?;
    let status = manager.install_managed(version.as_deref())?;
    print_status(&status, false)?;
    if !status.state.legacy_backups.is_empty() {
        for path in &status.state.legacy_backups {
            println!("legacy backup: {}", path.display());
        }
    }
    Ok(0)
}

fn run_update(args: &[OsString]) -> Result<i32, UpdateError> {
    if args
        .first()
        .is_some_and(|value| value == "--help" || value == "-h")
    {
        print!("{HELP}");
        return Ok(0);
    }
    let action = args
        .first()
        .and_then(|value| value.to_str())
        .unwrap_or("status");
    let rest = if args.is_empty() { &[][..] } else { &args[1..] };
    let prefix = option_value(rest, "--prefix")?.map(PathBuf::from);
    let json = rest.iter().any(|argument| argument == "--json");
    let mut manager = Manager::new(ManagerOptions {
        prefix,
        ..ManagerOptions::default()
    })?;
    match action {
        "status" => print_status(&manager.status()?, json)?,
        "check" => print_status(&manager.check(false)?, json)?,
        "__tick" => {
            let _ = manager.tick();
        }
        "configure" => {
            let change = parse_configure(rest)?;
            let config = manager.configure(change)?;
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&config)
                        .map_err(|error| UpdateError::new("UPDATE_FAILED", error.to_string()))?
                );
            } else {
                println!("policy: {:?}", config.policy);
                println!("channel: {}", config.channel.as_str());
                println!("check interval: {}h", config.check_interval_hours);
            }
        }
        "apply" => {
            require_confirmation(rest)?;
            let target = positional(rest, &["--prefix"]);
            print_status(&manager.apply(target.as_deref(), false)?, json)?;
        }
        "rollback" => {
            require_confirmation(rest)?;
            print_status(&manager.rollback()?, json)?;
        }
        "retry" => {
            require_confirmation(rest)?;
            let target = positional(rest, &["--prefix"]);
            print_status(&manager.retry(target.as_deref())?, json)?;
        }
        unknown => {
            return Ok(print_diagnostic(
                "UNKNOWN_COMMAND",
                Some(&format!("Unknown spark update action: {unknown}")),
                None,
                &["Run \"spark update --help\" to see the supported actions.".to_owned()],
            ));
        }
    }
    Ok(0)
}

fn parse_configure(args: &[OsString]) -> Result<ConfigureChange, UpdateError> {
    let mut filtered = Vec::<String>::new();
    let mut skip_value = false;
    for (index, value) in args.iter().enumerate() {
        if skip_value {
            skip_value = false;
            continue;
        }
        let Some(value) = value.to_str() else {
            continue;
        };
        if value == "--json" {
            continue;
        }
        if value == "--prefix" {
            skip_value = true;
            continue;
        }
        if index > 0 && args[index - 1] == "--prefix" {
            continue;
        }
        filtered.push(value.to_owned());
    }
    let filtered: Vec<&str> = filtered.iter().map(String::as_str).collect();
    let policy = long("policy").argument::<String>("POLICY").optional();
    let channel = long("channel").argument::<String>("CHANNEL").optional();
    let interval = long("interval-hours").argument::<u32>("HOURS").optional();
    let parser = construct!(policy, channel, interval).to_options();
    let (policy, channel, check_interval_hours) =
        parser.run_inner(filtered.as_slice()).map_err(|failure| {
            UpdateError::new("INVALID_ARGUMENT", failure.unwrap_stderr().to_string())
        })?;
    if policy.is_none() && channel.is_none() && check_interval_hours.is_none() {
        return Err(UpdateError::new(
            "INVALID_ARGUMENT",
            "spark update configure requires --policy, --channel, and/or --interval-hours",
        ));
    }
    Ok(ConfigureChange {
        policy: policy
            .map(|value| match value.as_str() {
                "manual" => Ok(UpdatePolicy::Manual),
                "notify" => Ok(UpdatePolicy::Notify),
                "auto" => Ok(UpdatePolicy::Auto),
                _ => Err(UpdateError::new(
                    "INVALID_ARGUMENT",
                    format!("Invalid update policy: {value}"),
                )),
            })
            .transpose()?,
        channel: channel
            .map(|value| match value.as_str() {
                "latest" => Ok(UpdateChannel::Latest),
                "next" => Ok(UpdateChannel::Next),
                _ => Err(UpdateError::new(
                    "INVALID_ARGUMENT",
                    format!("Invalid update channel: {value}"),
                )),
            })
            .transpose()?,
        check_interval_hours,
    })
}

fn print_status(status: &UpdateStatus, json: bool) -> Result<(), UpdateError> {
    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(status)
                .map_err(|error| UpdateError::new("UPDATE_FAILED", error.to_string()))?
        );
    } else {
        println!("managed: {}", if status.managed { "yes" } else { "no" });
        println!(
            "legacy state: {}",
            if status.legacy_state { "yes" } else { "no" }
        );
        println!("installation: {}", status.installation.method);
        println!("policy: {:?}", status.config.policy);
        println!("channel: {}", status.config.channel.as_str());
        println!(
            "current: {}",
            status.state.current_version.as_deref().unwrap_or("none")
        );
        println!(
            "available: {}",
            status.state.available_version.as_deref().unwrap_or("none")
        );
        println!(
            "pending: {}",
            status.state.pending_version.as_deref().unwrap_or("none")
        );
        if let Some(repair) = status.repair_command.as_deref() {
            println!("repair: {repair}");
        }
    }
    Ok(())
}

fn require_confirmation(args: &[OsString]) -> Result<(), UpdateError> {
    if args.iter().any(|argument| argument == "--yes") {
        Ok(())
    } else {
        Err(UpdateError::new(
            "CONFIRMATION_REQUIRED",
            "Rerun with --yes to confirm the change.",
        ))
    }
}

fn option_value(args: &[OsString], name: &str) -> Result<Option<String>, UpdateError> {
    for (index, argument) in args.iter().enumerate() {
        let Some(argument) = argument.to_str() else {
            continue;
        };
        if let Some(value) = argument.strip_prefix(&format!("{name}=")) {
            if value.is_empty() {
                return Err(UpdateError::new(
                    "INVALID_ARGUMENT",
                    format!("{name} requires a value"),
                ));
            }
            return Ok(Some(value.to_owned()));
        }
        if argument == name {
            let value = args
                .get(index + 1)
                .and_then(|value| value.to_str())
                .filter(|value| !value.starts_with("--"));
            return value.map(str::to_owned).map(Some).ok_or_else(|| {
                UpdateError::new("INVALID_ARGUMENT", format!("{name} requires a value"))
            });
        }
    }
    Ok(None)
}

fn unknown_options<'a>(
    args: &'a [OsString],
    allowed: &[&str],
    values: &[&str],
) -> Option<&'a OsString> {
    args.iter().enumerate().find_map(|(index, argument)| {
        let text = argument.to_str()?;
        if index > 0 && values.contains(&args[index - 1].to_str().unwrap_or_default()) {
            return None;
        }
        let name = text.split('=').next().unwrap_or(text);
        (!allowed.contains(&name)).then_some(argument)
    })
}

fn positional(args: &[OsString], value_options: &[&str]) -> Option<String> {
    args.iter().enumerate().find_map(|(index, argument)| {
        let text = argument.to_str()?;
        if text.starts_with('-')
            || (index > 0 && value_options.contains(&args[index - 1].to_str().unwrap_or_default()))
        {
            None
        } else {
            Some(text.to_owned())
        }
    })
}

fn map_run_args(args: &[OsString], prefix: &str) -> Result<Vec<OsString>, UpdateError> {
    let mut mapped = vec![OsString::from("submit")];
    let mut has_session = false;
    let mut index = 0;
    while index < args.len() {
        let argument = args[index].to_string_lossy();
        match argument.as_ref() {
            "--resume" | "--session" | "--session-id" | "-s" => {
                let session = args
                    .get(index + 1)
                    .filter(|value| !value.is_empty())
                    .ok_or_else(|| {
                        UpdateError::new(
                            "INVALID_ARGUMENT",
                            format!("spark run {argument} requires a session id"),
                        )
                    })?;
                mapped.push(OsString::from("--session"));
                mapped.push(session.clone());
                has_session = true;
                index += 2;
                continue;
            }
            "-w" => mapped.push(OsString::from("--wait")),
            _ if argument.starts_with("--resume=")
                || argument.starts_with("--session=")
                || argument.starts_with("--session-id=") =>
            {
                let value = argument
                    .split_once('=')
                    .map(|(_, value)| value)
                    .unwrap_or_default();
                if value.is_empty() {
                    return Err(UpdateError::new(
                        "INVALID_ARGUMENT",
                        "spark run --session requires a session id",
                    ));
                }
                mapped.push(OsString::from(format!("--session={value}")));
                has_session = true;
            }
            _ => mapped.push(args[index].clone()),
        }
        index += 1;
    }
    if !has_session {
        mapped.insert(1, OsString::from("--session"));
        mapped.insert(2, OsString::from(generated_session(prefix)));
    }
    Ok(mapped)
}

fn generated_session(prefix: &str) -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("{prefix}-{:x}-{nanos:x}", std::process::id())
}

#[derive(Clone, Copy, Debug)]
enum Target {
    Daemon,
    Hub,
    Acp,
    Mcp,
    Paths,
    Web,
}

impl Target {
    fn executable(self) -> &'static str {
        match self {
            Self::Daemon => "spark-daemon",
            Self::Hub => "spark-hub",
            Self::Acp => "spark-acp",
            Self::Mcp => "spark-mcp",
            Self::Paths => "spark-paths",
            Self::Web => "spark-web",
        }
    }

    fn environment(self) -> Option<&'static str> {
        match self {
            Self::Daemon => Some("SPARK_DAEMON_COMMAND"),
            Self::Hub => Some("SPARK_HUB_COMMAND"),
            Self::Mcp => Some("SPARK_MCP_COMMAND"),
            Self::Paths => Some("SPARK_PATHS_COMMAND"),
            Self::Web => Some("SPARK_WEB_COMMAND"),
            Self::Acp => Some("SPARK_ACP_COMMAND"),
        }
    }

    fn source_path(self) -> PathBuf {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
        root.join(match self {
            Self::Daemon => "apps/spark-daemon/bin/spark-daemon",
            Self::Hub => "apps/spark-hub/bin/spark-hub",
            Self::Acp => "packages/spark-acp/bin/spark-acp.ts",
            Self::Mcp => "packages/spark-mcp/bin/spark-mcp.ts",
            Self::Paths => "apps/spark-cli/bin/spark-paths",
            Self::Web => "apps/spark-web/bin/spark-web",
        })
    }
}

fn target_command(target: Target) -> OsString {
    if let Some(path) = target
        .environment()
        .and_then(env::var_os)
        .filter(|path| !path.is_empty())
    {
        return path;
    }
    let source = target.source_path();
    if source.exists() {
        return source.into_os_string();
    }
    if let Ok(current) = env::current_exe()
        && let Some(parent) = current.parent()
    {
        let adjacent = parent.join(target.executable());
        if adjacent.exists() {
            return adjacent.into_os_string();
        }
    }
    OsString::from(target.executable())
}

fn exec_target(target: Target, args: Vec<OsString>) -> Result<i32, UpdateError> {
    let command = target_command(target);
    let error = Command::new(&command).args(args).exec();
    let code = if error.kind() == std::io::ErrorKind::NotFound {
        127
    } else {
        1
    };
    let exit = print_diagnostic(
        "DISPATCH_FAILED",
        Some(&format!("Could not launch {}", target.executable())),
        Some(&format!("{}: {error}", Path::new(&command).display())),
        &[],
    );
    Ok(if code == 127 { exit } else { code })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(values: &[&str]) -> Vec<OsString> {
        values.iter().map(OsString::from).collect()
    }

    #[test]
    fn maps_run_and_background_session_contract() {
        let mapped =
            map_run_args(&words(&["--json", "--resume", "s1", "hello"]), "spark-run").unwrap();
        assert_eq!(
            mapped,
            words(&["submit", "--json", "--session", "s1", "hello"])
        );
        let mapped = map_run_args(&words(&["--json", "hello"]), "spark-bg").unwrap();
        assert_eq!(mapped[0], "submit");
        assert_eq!(mapped[1], "--session");
        assert!(mapped[2].to_string_lossy().starts_with("spark-bg-"));
    }

    #[test]
    fn resolves_source_companions_without_node_root_parser() {
        assert!(
            Target::Daemon
                .source_path()
                .ends_with("apps/spark-daemon/bin/spark-daemon")
        );
        assert!(
            Target::Paths
                .source_path()
                .ends_with("apps/spark-cli/bin/spark-paths")
        );
    }
}
