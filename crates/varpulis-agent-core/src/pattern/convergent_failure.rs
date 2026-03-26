/// Configuration for the targeted failure detector (per-session component
/// of convergent failure detection).
///
/// The per-session SASE pattern detects when a session repeatedly fails
/// on the same target (test, file, endpoint). Cross-session correlation
/// happens in the adapter/monitor layer using `ConvergentFailureTracker`.
#[derive(Debug, Clone)]
pub struct TargetedFailureConfig {
    /// Minimum number of failures on the same target within the window
    /// before emitting a detection. Default: 2.
    pub min_failures: u32,
    /// Sliding window in seconds. Default: 120.
    pub window_seconds: u64,
}

impl Default for TargetedFailureConfig {
    fn default() -> Self {
        Self {
            min_failures: 2,
            window_seconds: 120,
        }
    }
}
