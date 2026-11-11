use super::state::Ui;
use super::*;
use crate::controller::{Client, Model, Pane, Phase};
use neko_remoted_protocol::messages::{FileEntry, Permission, Resource};
use nsh_core::{
    Size,
    element::Root,
    platform::{Environment, Os},
};
use nsh_engine::{ColorScheme, EngineConfig};
use nsh_testing::Headless;
use std::time::Duration;

fn fixture(model: Model, connected: bool) -> impl IntoElement {
    provide_context(crate::terminal::factory());
    let (sender, mut receiver) = tokio::sync::mpsc::channel(32);
    let ui = Ui::new(model, Client::fixture(sender));
    let last = signal(String::new());
    spawn(async move {
        while let Some(command) = receiver.recv().await {
            last.set(format!("COMMAND {command:?}"));
        }
    });
    view()
        .flex_1()
        .child(text(move || last.get()).number_of_lines(1))
        .child(controls::action(
            "加载已保存 Relay（测试）",
            false,
            || false,
            move || {
                ui.model.update(|model| {
                    model.relay = Some(
                        neko_remoted_protocol::RelayAddress::parse("https://saved.example.com")
                            .unwrap(),
                    )
                });
                last.set("PREFERENCE LOADED".into());
            },
        ))
        .child(if connected {
            workspace::render(ui).into_element()
        } else {
            connection::render(ui).into_element()
        })
}

fn ready(permission: Permission) -> Model {
    Model {
        phase: Phase::Ready,
        permission: Some(permission),
        resources: vec![Resource {
            id: "grant".into(),
            name: "开发主机".into(),
            backend: "ssh".into(),
            terminal: true,
            herdr: true,
            files: true,
        }],
        file_grant: "grant".into(),
        path: "project".into(),
        entries: vec![FileEntry {
            name: "example.txt".into(),
            directory: false,
            size: 7,
        }],
        panes: vec![Pane {
            stream: "stream".into(),
            name: "终端一".into(),
            controller: false,
            read_only: permission == Permission::ReadOnly,
            exit: None,
            gap: false,
        }],
        ..Model::default()
    }
}

#[component]
fn ConnectionFixture() -> impl IntoElement {
    fixture(Model::default(), false)
}

#[component]
fn PendingFixture() -> impl IntoElement {
    fixture(
        Model {
            phase: Phase::AwaitingApproval,
            fingerprint: "host-fingerprint".into(),
            ..Model::default()
        },
        false,
    )
}

#[component]
fn ReadOnlyFixture() -> impl IntoElement {
    fixture(ready(Permission::ReadOnly), true)
}

#[component]
fn OperateFixture() -> impl IntoElement {
    fixture(ready(Permission::Operate), true)
}

#[component]
fn TerminalModesFixture() -> impl IntoElement {
    let (sender, mut receiver) = tokio::sync::mpsc::channel(32);
    let ui = Ui::new(ready(Permission::Operate), Client::fixture(sender));
    let pane = signal(ui.model.with_untracked(|model| model.panes[0].clone()));
    let snapshot = signal(String::new());
    let inputs = signal(0_u32);
    spawn(async move {
        while let Some(command) = receiver.recv().await {
            if matches!(
                command,
                crate::controller::Command::Request(
                    neko_remoted_protocol::messages::Operation::TerminalInput { .. }
                )
            ) {
                inputs.update(|count| *count += 1);
            }
        }
    });
    view()
        .flex_1()
        .min_h(px(0.0))
        .child(text(move || format!("INPUTS={}", inputs.get())))
        .child(text(move || snapshot.get()).number_of_lines(1))
        .child(controls::action(
            "测试授予控制",
            false,
            || false,
            move || pane.update(|pane| pane.controller = true),
        ))
        .child(controls::action(
            "测试释放控制",
            false,
            || false,
            move || pane.update(|pane| pane.controller = false),
        ))
        .child(controls::action(
            "测试追加输出",
            false,
            || false,
            move || {
                let surface = ui.refs.with(|refs| refs.get("stream").cloned()).unwrap();
                surface.write("\x1b[31m唯一猫\x1b[0m\x1b[?2004h\x1b[6n".into());
            },
        ))
        .child(controls::action(
            "测试读取缓冲",
            false,
            || false,
            move || {
                let surface = ui.refs.with(|refs| refs.get("stream").cloned()).unwrap();
                let colored = (0..surface.buffer.line_count()).any(|index| {
                    surface
                        .buffer
                        .line(index)
                        .runs
                        .iter()
                        .any(|run| run.style.fg.is_some())
                });
                snapshot.set(format!(
                    "COLORED={colored};BRACKETED={};CURSOR={:?};BUFFER={:?}",
                    surface.buffer.modes().bracketed_paste,
                    surface.buffer.cursor(),
                    surface.buffer.text()
                ));
            },
        ))
        .child(controls::action(
            "测试重置输出",
            false,
            || false,
            move || ui.refs.with(|refs| refs.get("stream").unwrap().reset()),
        ))
        .child(terminal_view::render(ui, pane.read_only()))
}

#[component]
fn SavedBindingFixture() -> impl IntoElement {
    let relay = neko_remoted_protocol::RelayAddress::parse("https://relay.example.com").unwrap();
    fixture(
        Model {
            phase: Phase::RelayReady,
            relay: Some(relay.clone()),
            bindings: vec![crate::storage::Binding {
                relay,
                route: neko_remoted_protocol::encode(&[1; 32]),
                host_key: neko_remoted_protocol::encode(&[2; 32]),
                device_id: "saved-device".into(),
            }],
            ..Model::default()
        },
        false,
    )
}

#[component]
fn ObserverScrollFixture() -> impl IntoElement {
    let surface = terminal_surface::Surface::new();
    surface.write(
        (0..80)
            .map(|index| format!("\x1b[32mROW-{index:03}\x1b[0m\r\n"))
            .collect(),
    );
    terminal_observer::render(surface.buffer, signal((80, 24)))
}

fn start<C: Component<Props = ()>>(width: f32, scheme: ColorScheme) -> Headless {
    let mut app = Headless::start(EngineConfig {
        viewport: Size::new(px(width), px(844.0)),
        environment: Environment {
            os: Os::Android,
            color_scheme: scheme,
            ..Environment::default()
        },
        ..EngineConfig::new(
            Root::of::<C>().tokens(nsh_base::tokens_of(Some(include_str!("theme.json"))).unwrap()),
        )
    })
    .unwrap();
    app.first_render().unwrap();
    app
}

#[test]
fn actual_app_mounts_the_page_scoped_body_and_labelled_relay_field() {
    let mut app = start::<App>(390.0, ColorScheme::Light);
    app.wait_for("Relay 地址").unwrap();
    app.wait_for("未连接").unwrap();
    assert_eq!(app.screen().input_text("Relay 地址").unwrap(), Some(""));
    assert!(!app.shows("请求主机批准"));
}

#[test]
fn relay_form_uses_real_check_command_and_defers_pairing() {
    let mut app = start::<ConnectionFixture>(360.0, ColorScheme::Light);
    app.wait_for("Relay 地址").unwrap();
    assert!(!app.shows("请求主机批准"));
    app.type_text("Relay 地址", "https://relay.example.com")
        .unwrap();
    app.press("检查并连接 Relay").unwrap();
    app.wait_until("relay check command", Duration::from_secs(3), |screen| {
        screen
            .texts()
            .iter()
            .any(|text| text.contains("Check(\"https://relay.example.com\")"))
    })
    .unwrap();
}

#[test]
fn delayed_saved_relay_prefills_without_connecting() {
    let mut app = start::<ConnectionFixture>(390.0, ColorScheme::Light);
    app.press("加载已保存 Relay（测试）").unwrap();
    app.wait_for("PREFERENCE LOADED").unwrap();
    assert_eq!(
        app.screen().input_text("Relay 地址").unwrap(),
        Some("wss://saved.example.com")
    );
    assert!(!app.shows("请求主机批准"));
    assert!(!app.shows("重新连接"));
}

#[test]
fn delayed_saved_relay_does_not_replace_user_edit() {
    let mut app = start::<ConnectionFixture>(360.0, ColorScheme::Dark);
    app.type_text("Relay 地址", "https://typed.example.com")
        .unwrap();
    app.press("加载已保存 Relay（测试）").unwrap();
    app.wait_for("PREFERENCE LOADED").unwrap();
    assert_eq!(
        app.screen().input_text("Relay 地址").unwrap(),
        Some("https://typed.example.com")
    );
}

#[test]
fn pending_approval_has_cancel_and_host_fingerprint_without_resources() {
    let mut app = start::<PendingFixture>(390.0, ColorScheme::Dark);
    app.wait_for("主机指纹：host-fingerprint").unwrap();
    assert!(!app.shows("打开普通终端"));
    app.press("取消连接").unwrap();
    app.wait_for("COMMAND Disconnect").unwrap();
}

#[test]
fn readonly_workspace_can_browse_download_but_cannot_claim_control() {
    let mut app = start::<ReadOnlyFixture>(390.0, ColorScheme::Dark);
    app.wait_for("只读授权：可以浏览和下载，不能上传。")
        .unwrap();
    assert_eq!(app.screen().press_target("取得控制权").unwrap(), None);
    assert_eq!(app.screen().press_target("选择文件上传").unwrap(), None);
    app.press("打开普通终端").unwrap();
    app.wait_until("attach command", Duration::from_secs(3), |screen| {
        screen
            .texts()
            .iter()
            .any(|text| text.contains("TerminalAttach { grant: \"grant\", pane: None }"))
    })
    .unwrap();
    app.scroll("resource-tools", px(10000.0)).unwrap();
    app.press("下载并校验").unwrap();
    app.wait_until("download command", Duration::from_secs(3), |screen| {
        screen
            .texts()
            .iter()
            .any(|text| text.contains("Download { grant: \"grant\", path: \"project/example.txt\""))
    })
    .unwrap();
    assert!(
        app.screen()
            .texts()
            .iter()
            .any(|text| text.contains("只读浏览"))
    );
}

#[test]
fn operate_workspace_requires_explicit_control_and_uses_real_herdr_and_file_requests() {
    let mut app = start::<OperateFixture>(1200.0, ColorScheme::Light);
    app.wait_for("取得控制权").unwrap();
    assert!(
        app.screen()
            .texts()
            .iter()
            .any(|text| text.contains("只读浏览"))
    );
    app.press("取得控制权").unwrap();
    app.wait_until(
        "explicit control command",
        Duration::from_secs(3),
        |screen| {
            screen
                .texts()
                .iter()
                .any(|text| text.contains("TerminalControl { stream: \"stream\", take: true }"))
        },
    )
    .unwrap();
    app.press("查看 Herdr 会话与窗格").unwrap();
    app.wait_until("herdr snapshot command", Duration::from_secs(3), |screen| {
        screen
            .texts()
            .iter()
            .any(|text| text.contains("session.snapshot"))
    })
    .unwrap();
    app.scroll("resource-tools", px(10000.0)).unwrap();
    app.press("选择文件上传").unwrap();
    app.wait_until("upload command", Duration::from_secs(3), |screen| {
        screen
            .texts()
            .iter()
            .any(|text| text.contains("Upload { grant: \"grant\", directory: \"project\" }"))
    })
    .unwrap();
}

#[test]
fn readonly_and_uncontrolled_panes_have_no_editable_input_but_keep_selectable_output() {
    for permission in [Permission::ReadOnly, Permission::Operate] {
        let mut app = match permission {
            Permission::ReadOnly => start::<ReadOnlyFixture>(390.0, ColorScheme::Light),
            Permission::Operate => start::<OperateFixture>(390.0, ColorScheme::Light),
        };
        app.wait_for("terminal-observer").unwrap();
        assert_eq!(
            app.screen()
                .input_text("远程终端；取得控制权后可输入")
                .unwrap(),
            None
        );
        assert!(
            app.screen()
                .in_selectable_view("terminal-observer")
                .unwrap()
        );
    }
}

#[test]
fn terminal_control_switch_preserves_ansi_state_without_duplicate_feed_or_query_replies() {
    let mut app = start::<TerminalModesFixture>(390.0, ColorScheme::Dark);
    app.wait_for("terminal-observer").unwrap();
    app.press("测试追加输出").unwrap();
    app.wait_for("唯一猫").unwrap();
    assert!(app.screen().in_selectable_view("唯一猫").unwrap());
    app.press("测试读取缓冲").unwrap();
    app.wait_until("colored VT snapshot", Duration::from_secs(3), |screen| {
        screen
            .texts()
            .iter()
            .any(|text| text.starts_with("COLORED=true;BRACKETED=true;"))
    })
    .unwrap();
    let before = app
        .screen()
        .texts()
        .into_iter()
        .find(|text| text.starts_with("COLORED="))
        .unwrap()
        .to_owned();
    assert_eq!(before.matches("唯一猫").count(), 1);
    assert!(app.shows("INPUTS=0"));
    app.press("测试授予控制").unwrap();
    app.wait_until(
        "native input after control",
        Duration::from_secs(3),
        |screen| {
            screen
                .input_text("远程终端；取得控制权后可输入")
                .ok()
                .flatten()
                .is_some()
        },
    )
    .unwrap();
    app.press("测试读取缓冲").unwrap();
    app.wait_for(&before).unwrap();
    app.press("测试追加输出").unwrap();
    app.press("测试读取缓冲").unwrap();
    app.wait_until(
        "exactly two output feeds",
        Duration::from_secs(3),
        |screen| {
            screen
                .texts()
                .iter()
                .any(|text| text.starts_with("COLORED=") && text.matches("唯一猫").count() == 2)
        },
    )
    .unwrap();
    assert!(app.shows("INPUTS=0"));
    app.type_text("远程终端；取得控制权后可输入", "x").unwrap();
    app.wait_for("INPUTS=1").unwrap();
    app.press("测试释放控制").unwrap();
    app.wait_for("terminal-observer").unwrap();
    assert_eq!(
        app.screen()
            .input_text("远程终端；取得控制权后可输入")
            .unwrap(),
        None
    );
    app.press("测试读取缓冲").unwrap();
    assert!(
        app.screen()
            .texts()
            .iter()
            .any(|text| text.starts_with("COLORED=true;BRACKETED=true;")
                && text.matches("唯一猫").count() == 2)
    );
    app.press("测试重置输出").unwrap();
    app.press("测试读取缓冲").unwrap();
    app.wait_until(
        "reset clears terminal and input modes",
        Duration::from_secs(3),
        |screen| {
            screen.texts().iter().any(|text| {
                text.starts_with("COLORED=false;BRACKETED=false;") && !text.contains("唯一猫")
            })
        },
    )
    .unwrap();
}

#[test]
fn forgetting_a_binding_is_explicitly_local_and_sends_the_exact_binding() {
    let mut app = start::<SavedBindingFixture>(390.0, ColorScheme::Light);
    app.wait_for("忘记此配对（仅本机）").unwrap();
    assert!(
        app.screen()
            .texts()
            .iter()
            .any(|text| text.contains("不撤销主机授权"))
    );
    app.press("忘记此配对（仅本机）").unwrap();
    app.wait_until("local forget command", Duration::from_secs(3), |screen| {
        screen.texts().iter().any(|text| {
            text.starts_with("COMMAND Forget(Binding")
                && text.contains("saved-device")
                && text.contains("relay.example.com")
        })
    })
    .unwrap();
}

#[test]
fn readonly_observer_has_real_scrollback_and_selectable_rows_without_an_input() {
    let mut app = start::<ObserverScrollFixture>(390.0, ColorScheme::Light);
    app.wait_for("terminal-observer").unwrap();
    app.scroll("terminal-observer", px(-180.0)).unwrap();
    let row = app
        .screen()
        .texts()
        .into_iter()
        .find(|text| text.starts_with("ROW-"))
        .unwrap()
        .to_owned();
    assert!(app.screen().in_selectable_view(&row).unwrap());
    assert_eq!(
        app.screen()
            .input_text("远程终端；取得控制权后可输入")
            .unwrap(),
        None
    );
    app.scroll("terminal-observer", px(180.0)).unwrap();
}

#[test]
fn public_relay_shortcut_only_edits_draft_and_survives_delayed_preference() {
    let mut app = start::<ConnectionFixture>(480.0, ColorScheme::Light);
    assert_eq!(app.screen().input_text("Relay 地址").unwrap(), Some(""));
    app.press("Use public relay").unwrap();
    assert_eq!(
        app.screen().input_text("Relay 地址").unwrap(),
        Some("https://neko-relay.czyt.eu.org")
    );
    assert!(
        !app.screen()
            .texts()
            .iter()
            .any(|text| text.contains("COMMAND"))
    );
    assert!(!app.shows("请求主机批准"));
    app.press("加载已保存 Relay（测试）").unwrap();
    app.wait_for("PREFERENCE LOADED").unwrap();
    assert_eq!(
        app.screen().input_text("Relay 地址").unwrap(),
        Some("https://neko-relay.czyt.eu.org")
    );
    app.press("检查并连接 Relay").unwrap();
    app.wait_for("COMMAND Check(\"https://neko-relay.czyt.eu.org\")")
        .unwrap();
}

#[test]
fn public_relay_shortcut_has_chinese_copy_and_keeps_existing_bindings() {
    let mut config = EngineConfig::new(
        Root::of::<SavedBindingFixture>()
            .tokens(nsh_base::tokens_of(Some(include_str!("theme.json"))).unwrap()),
    );
    config.environment.locale = nsh_core::platform::Locale::parse("zh-CN").unwrap();
    let mut app = Headless::start(config).unwrap();
    app.first_render().unwrap();
    app.press("编辑 Relay").unwrap();
    app.press("使用公共中转").unwrap();
    assert_eq!(
        app.screen().input_text("Relay 地址").unwrap(),
        Some("https://neko-relay.czyt.eu.org")
    );
    assert!(app.shows("重新连接"));
    assert!(
        !app.screen()
            .texts()
            .iter()
            .any(|text| text.contains("COMMAND"))
    );
}
