use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub const STATE_SCHEMA_VERSION: u32 = 2;
pub const DEPLOYMENT_GENERATION: &str = "native";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub schema_version: u32,
    pub package_name: String,
    pub version: String,
    pub git_sha: String,
    pub protocol_version: u32,
    pub minimum_node_version: String,
    pub migration_head: String,
    pub migration_mode: String,
    #[serde(default)]
    pub deployment_generation: Option<u32>,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdatePolicy {
    Manual,
    Notify,
    Auto,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    Latest,
    Next,
}

impl UpdateChannel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Latest => "latest",
            Self::Next => "next",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfig {
    pub policy: UpdatePolicy,
    pub channel: UpdateChannel,
    pub check_interval_hours: u32,
}

impl Default for UpdateConfig {
    fn default() -> Self {
        Self {
            policy: UpdatePolicy::Notify,
            channel: UpdateChannel::Latest,
            check_interval_hours: 24,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct QuarantinedVersion {
    pub version: String,
    pub reason: String,
    pub quarantined_at: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateFailure {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    pub code: String,
    pub message: String,
    pub count: u32,
    pub first_at: String,
    pub last_at: String,
    pub next_retry_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_logged_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_notified_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    pub schema_version: u32,
    pub generation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pending_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_good_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_good_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollback_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollback_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_check_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub registry_etag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_available_notified_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_available_notified_at: Option<String>,
    #[serde(default)]
    pub quarantined: Vec<QuarantinedVersion>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<UpdateFailure>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub legacy_backups: Vec<PathBuf>,
}

impl Default for UpdateState {
    fn default() -> Self {
        Self {
            schema_version: STATE_SCHEMA_VERSION,
            generation: DEPLOYMENT_GENERATION.to_owned(),
            current_version: None,
            current_fingerprint: None,
            available_version: None,
            pending_version: None,
            pending_fingerprint: None,
            last_good_version: None,
            last_good_fingerprint: None,
            rollback_version: None,
            rollback_fingerprint: None,
            last_check_at: None,
            registry_etag: None,
            last_available_notified_version: None,
            last_available_notified_at: None,
            quarantined: Vec::new(),
            failure: None,
            legacy_backups: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePaths {
    pub versions_dir: PathBuf,
    pub current_link: PathBuf,
    pub config_file: PathBuf,
    pub state_dir: PathBuf,
    pub state_file: PathBuf,
    pub lock_file: PathBuf,
    pub cache_dir: PathBuf,
    pub staging_dir: PathBuf,
    pub launcher_path: PathBuf,
    pub updater_launch_agent_path: PathBuf,
    pub backups_dir: PathBuf,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Installation {
    pub method: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command_path: Option<PathBuf>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update_command: Option<String>,
    pub automatic_updates: bool,
    pub rollback: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStatus {
    pub managed: bool,
    pub legacy_state: bool,
    pub installation: Installation,
    pub config: UpdateConfig,
    pub state: UpdateState,
    pub paths: UpdatePaths,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair_command: Option<String>,
}

#[derive(Clone, Debug)]
pub struct AvailableRelease {
    pub version: String,
    pub integrity: String,
    pub tarball: String,
    pub node_requirement: Option<String>,
    pub etag: Option<String>,
    pub not_modified: bool,
}
