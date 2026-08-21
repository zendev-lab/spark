mod manager;
mod model;
mod paths;
mod registry;
mod state;
mod util;

pub use manager::{
    ConfigureChange, Manager, ManagerOptions, Result, UpdateError, can_automatically_apply,
    read_build_info,
};
pub use model::*;
pub use paths::{installed_native_binary, native_alias_name, platform_target, resolve_paths};
pub use state::{
    StateRead, UpdateLock, native_state, read_config, read_state, write_config, write_state,
};

#[cfg(test)]
mod contract_tests {
    use super::{BuildInfo, UpdateState};

    #[test]
    fn reads_shared_native_state_fixture() {
        let state: UpdateState =
            serde_json::from_str(include_str!("../../fixtures/native-state-v2.json")).unwrap();
        assert_eq!(state.schema_version, 2);
        assert_eq!(state.generation, "native");
        assert_eq!(state.legacy_backups.len(), 1);
    }

    #[test]
    fn reads_shared_build_info_fixture() {
        let build: BuildInfo =
            serde_json::from_str(include_str!("../../fixtures/build-info-v2.json")).unwrap();
        assert_eq!(build.deployment_generation, Some(2));
        assert_eq!(build.protocol_version, 3);
    }
}
