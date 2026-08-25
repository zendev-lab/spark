use crate::model::UpdatePaths;
use std::env;
use std::path::{Path, PathBuf};

fn nonempty_env(name: &str) -> Option<PathBuf> {
    env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
}

fn home_dir() -> Result<PathBuf, String> {
    nonempty_env("HOME").ok_or_else(|| "HOME is required to resolve Spark user paths".to_owned())
}

fn xdg_root(variable: &str, fallback: &str) -> Result<PathBuf, String> {
    Ok(nonempty_env(variable).unwrap_or(home_dir()?.join(fallback)))
}

pub fn resolve_paths(prefix: Option<&Path>) -> Result<UpdatePaths, String> {
    let data_root = xdg_root("XDG_DATA_HOME", ".local/share")?.join("spark");
    let config_root = xdg_root("XDG_CONFIG_HOME", ".config")?.join("spark");
    let state_root = xdg_root("XDG_STATE_HOME", ".local/state")?.join("spark");
    let cache_root = xdg_root("XDG_CACHE_HOME", ".cache")?.join("spark");
    let prefix = prefix
        .map(Path::to_path_buf)
        .or_else(|| nonempty_env("SPARK_INSTALL_PREFIX"))
        .unwrap_or(home_dir()?.join(".local"));
    let state_dir = nonempty_env("SPARK_MANAGED_STATE_DIR").unwrap_or(state_root.join("update"));
    let cache_dir = nonempty_env("SPARK_MANAGED_CACHE_DIR").unwrap_or(cache_root.join("update"));
    let versions_dir =
        nonempty_env("SPARK_MANAGED_VERSIONS_DIR").unwrap_or(data_root.join("versions"));
    let config_file =
        nonempty_env("SPARK_MANAGED_CONFIG_FILE").unwrap_or(config_root.join("update.toml"));
    let launcher_path = if prefix.as_os_str().is_empty() {
        return Err("Spark install prefix must not be empty".to_owned());
    } else if let Some(path) = nonempty_env("SPARK_STABLE_LAUNCHER") {
        path
    } else {
        prefix.join("bin/spark")
    };
    Ok(UpdatePaths {
        current_link: versions_dir.join("current"),
        state_file: state_dir.join("state.json"),
        lock_file: state_dir.join("update.lock"),
        staging_dir: cache_dir.join("staging"),
        updater_launch_agent_path: home_dir()?.join("Library/LaunchAgents/dev.spark.updater.plist"),
        backups_dir: state_root.join("update-backups"),
        versions_dir,
        config_file,
        state_dir,
        cache_dir,
        launcher_path,
    })
}

pub fn platform_target() -> Result<&'static str, String> {
    match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => Ok("aarch64-apple-darwin"),
        ("macos", "x86_64") => Ok("x86_64-apple-darwin"),
        ("linux", "aarch64") => Ok("aarch64-unknown-linux-musl"),
        ("linux", "x86_64") => Ok("x86_64-unknown-linux-musl"),
        (os, arch) => Err(format!("unsupported platform {os}/{arch}")),
    }
}

pub fn native_alias_name() -> Result<String, String> {
    let suffix = match platform_target()? {
        "aarch64-apple-darwin" => "darwin-arm64",
        "x86_64-apple-darwin" => "darwin-x64",
        "aarch64-unknown-linux-musl" => "linux-arm64",
        "x86_64-unknown-linux-musl" => "linux-x64",
        _ => unreachable!(),
    };
    Ok(format!("spark-cli-{suffix}"))
}

pub fn installed_native_binary(version_root: &Path) -> Result<PathBuf, String> {
    Ok(version_root
        .join("node_modules/@zendev-lab")
        .join(native_alias_name()?)
        .join("vendor")
        .join(platform_target()?)
        .join("spark"))
}
