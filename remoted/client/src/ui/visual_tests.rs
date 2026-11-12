//! Local graphical preview; no platform services, credentials or network client.
//! Register with `#[cfg(all(test, target_os = "linux"))] mod visual_tests;`.
use super::{
    navigation::Section,
    shell,
    state::{Chunk, Ui},
};
use crate::controller::{Client, Command, Model, Pane, PaneKind, Phase};
use neko_remoted_protocol::{
    RelayAddress, encode,
    messages::{Permission, Resource},
};
use nsh_core::{element::Root, prelude::*};

#[component]
fn SessionPreview() -> impl IntoElement {
    provide_context(crate::terminal::factory());
    let relay = RelayAddress::parse("https://relay.example.com").expect("preview origin");
    let binding = crate::storage::Binding {
        relay: relay.clone(),
        route: encode(&[1; 32]),
        host_key: encode(&[2; 32]),
        device_id: "preview-device".into(),
    };
    let (sender, mut receiver) = tokio::sync::mpsc::channel(32);
    let ui = Ui::new(
        Model {
            phase: Phase::Ready,
            permission: Some(Permission::Operate),
            relay: Some(relay),
            active_binding: Some(binding.clone()),
            bindings: vec![binding],
            resources: vec![
                Resource {
                    id: "preview-terminal".into(),
                    name: "开发主机终端".into(),
                    backend: "ssh".into(),
                    terminal: true,
                    herdr: false,
                    files: true,
                },
                Resource {
                    id: "preview-herdr".into(),
                    name: "项目工作区".into(),
                    backend: "herdr".into(),
                    terminal: true,
                    herdr: true,
                    files: false,
                },
            ],
            panes: vec![
                Pane {
                    kind: PaneKind::Herdr,
                    stream: "preview-herdr".into(),
                    name: "Herdr · 项目工作区".into(),
                    controller: false,
                    read_only: false,
                    exit: None,
                    gap: false,
                },
                Pane {
                    kind: PaneKind::Terminal,
                    stream: "preview-terminal".into(),
                    name: "终端 · 开发主机".into(),
                    controller: true,
                    read_only: false,
                    exit: None,
                    gap: false,
                },
            ],
            ..Model::default()
        },
        Client::fixture(sender),
    );
    let herdr = std::env::var("NEKO_PREVIEW_SECTION").as_deref() == Ok("herdr");
    ui.navigation.section.set(if herdr {
        Section::Herdr
    } else {
        Section::Terminal
    });
    ui.active.set(
        if herdr {
            "preview-herdr"
        } else {
            "preview-terminal"
        }
        .into(),
    );
    ui.pending.with(|pending| {
        for (stream, text) in [
            ("preview-terminal", "\x1b[32mdeveloper@neko\x1b[0m:~/project$ git status\r\nOn branch main\r\nWorking tree clean\r\n\r\n\x1b[32mdeveloper@neko\x1b[0m:~/project$ "),
            ("preview-herdr", "Herdr · 项目工作区\r\n\r\n当前 pane 的真实终端输出显示在这里。\r\n取得控制权后可向此 pane 输入。\r\n"),
        ] {
            pending.entry(stream.into()).or_default().push_back(Chunk { text: text.into(), reset: false });
        }
    });
    spawn(async move {
        while let Some(command) = receiver.recv().await {
            if std::env::var("NEKO_PREVIEW_DIAGNOSTICS").as_deref() == Ok("1")
                && let Command::Request(neko_remoted_protocol::messages::Operation::TerminalInput {
                    stream,
                    data,
                }) = &command
            {
                eprintln!("preview TerminalInput stream={stream}; data={data}");
            }
            ui.model
                .update(|m| m.notice = "图形预览：操作未发送到任何主机。".into());
        }
    });
    provide_context(ui);
    if std::env::var("NEKO_PREVIEW_DIAGNOSTICS").as_deref() == Ok("1") {
        spawn(async move {
            timer(std::time::Duration::from_secs(1)).await;
            ui.refs.with(|surfaces| {
                for (stream, surface) in surfaces {
                    if std::env::var("NEKO_PREVIEW_LATE_OUTPUT").as_deref() == Ok("1") {
                        surface.write(format!(
                            "\r\n\x1b[32mLAYOUT-STABLE {stream}\x1b[0m\r\nNative output rendering check\r\n"
                        ));
                    }
                    eprintln!(
                        "preview {stream}: size={:?}; text={:?}",
                        surface.buffer.size.get_untracked(),
                        surface.buffer.text()
                    );
                }
            });
        });
    }
    nsh_base::nav_stack().flex_1().child(
        nsh_base::nav_page()
            .header_visible(false)
            .child(shell::body()),
    )
}

#[test]
#[ignore = "opens an isolated Linux graphical preview; close the window to finish"]
fn linux_session_preview() {
    assert_eq!(
        std::env::var("DISPLAY").as_deref(),
        Ok(":199"),
        "preview must use the task-owned :199 Xvfb display, never the user desktop"
    );
    let size = if std::env::var("NEKO_PREVIEW_NARROW").as_deref() == Ok("1") {
        (390, 844)
    } else {
        (1100, 760)
    };
    let appearance = if std::env::var("NEKO_PREVIEW_DARK").as_deref() == Ok("1") {
        nsh_platform_linux::Appearance::Dark
    } else {
        nsh_platform_linux::Appearance::Light
    };
    let root = Root::of::<SessionPreview>()
        .tokens(nsh_base::tokens_of(Some(include_str!("theme.json"))).expect("preview theme"));
    let _ = nsh_platform_linux::run_app(
        nsh_platform_linux::AppSource::Rust(root),
        nsh_platform_linux::AppOptions {
            title: "neoko-terminal isolated UI preview".into(),
            app_id: "community.lazycat.neko.remoted.preview".into(),
            size,
            appearance,
            data_dir: Some(std::env::temp_dir().join("neko-ui-preview")),
            ..Default::default()
        },
    );
}
