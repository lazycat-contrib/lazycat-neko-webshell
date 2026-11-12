//! Runs the Rust application directly on the machine's native backend.

#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

#[cfg(target_os = "linux")]
use nsh_platform_linux as platform;
#[cfg(target_os = "macos")]
use nsh_platform_macos as platform;
#[cfg(target_os = "windows")]
use nsh_platform_windows as platform;

#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]
fn main() -> impl std::process::Termination {
    env_logger::init();
    let _instance = match neko_remoted_client::platform::initialize() {
        Ok(instance) => instance,
        Err(error) => {
            eprintln!("Cannot start neoko-terminal: {error:#}");
            return std::process::ExitCode::FAILURE;
        }
    };
    std::process::Termination::report(platform::run_app(
        platform::AppSource::Rust(neko_remoted_client::root()),
        platform::AppOptions {
            title: "neoko-terminal".to_owned(),
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            app_id: "community.lazycat.neko.remoted".to_owned(),
            size: (1100, 760),
            ..Default::default()
        },
    ))
}

#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
compile_error!(
    "Run this binary on macOS, Windows or Linux; use the Android embedding host for Android."
);
