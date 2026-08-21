use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

fn temporary_directory(label: &str) -> PathBuf {
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let path =
        std::env::temp_dir().join(format!("spark-cli-{label}-{}-{nonce}", std::process::id()));
    fs::create_dir(&path).unwrap();
    path
}

fn spark() -> Command {
    Command::new(env!("CARGO_BIN_EXE_spark"))
}

#[test]
fn routes_web_arguments_with_the_companion_exit_code() {
    let temporary = temporary_directory("route");
    let arguments = temporary.join("arguments");
    let companion = temporary.join("web");
    fs::write(
        &companion,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\nexit 17\n",
            arguments.display()
        ),
    )
    .unwrap();
    fs::set_permissions(&companion, fs::Permissions::from_mode(0o755)).unwrap();

    let status = spark()
        .env("SPARK_WEB_COMMAND", companion)
        .args(["web", "--port", "3999"])
        .status()
        .unwrap();
    assert_eq!(status.code(), Some(17));
    assert_eq!(fs::read_to_string(arguments).unwrap(), "--port\n3999\n");
}

#[test]
fn preserves_companion_signals_through_unix_exec() {
    let status = spark()
        .env("SPARK_WEB_COMMAND", "/bin/sh")
        .args(["web", "-c", "kill -TERM $$"])
        .status()
        .unwrap();
    assert_eq!(status.signal(), Some(15));
}

#[test]
fn emits_stable_json_build_info() {
    let fixture = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/spark-update/fixtures/build-info-v2.json");
    let output = spark()
        .env("SPARK_BUILD_INFO_PATH", fixture)
        .args(["version", "--json"])
        .output()
        .unwrap();
    assert!(output.status.success());
    let build: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(build["deploymentGeneration"], 2);
    assert_eq!(build["protocolVersion"], 3);
}

#[test]
fn unknown_commands_use_the_diagnostic_catalog_exit_code() {
    let output = spark().arg("does-not-exist").output().unwrap();
    assert_eq!(output.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&output.stderr).contains("[UNKNOWN_COMMAND]"));
}
