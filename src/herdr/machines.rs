use super::*;
use crate::herdr_machines::{
    MACHINE_SETUP_SECONDS, MAX_MACHINE_OUTPUT, MIN_MACHINE_AGENT_VERSION, MachineAction,
    MachineCatalog,
};
use std::process::Stdio;
use tokio::io::AsyncReadExt as _;

static MUTATIONS: LazyLock<Mutex<HashMap<String, Weak<tokio::sync::Mutex<()>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
fn mutation_lock(target: &AuthorizedHerdrTarget) -> Arc<tokio::sync::Mutex<()>> {
    let mut locks = MUTATIONS
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    locks.retain(|_, lock| lock.strong_count() > 0);
    let key = format!("{}:{}", target.selector, target.login_user);
    if let Some(lock) = locks.get(&key).and_then(Weak::upgrade) {
        return lock;
    }
    let lock = Arc::new(tokio::sync::Mutex::new(()));
    locks.insert(key, Arc::downgrade(&lock));
    lock
}
fn error(status: StatusCode, message: impl ToString) -> HerdrBridgeError {
    HerdrBridgeError {
        status,
        message: message.to_string(),
    }
}

pub(crate) async fn list(
    Query(query): Query<HerdrQuery>,
) -> Result<Json<MachineCatalog>, HerdrBridgeError> {
    let target = authorize_herdr_target_at_least(&query.name, MIN_MACHINE_AGENT_VERSION).await?;
    request(&target, MachineAction::List {}).await.map(Json)
}

pub(crate) async fn mutate(
    Query(query): Query<HerdrQuery>,
    Json(action): Json<MachineAction>,
) -> Result<Json<MachineCatalog>, HerdrBridgeError> {
    action
        .args()
        .map_err(|err| error(StatusCode::BAD_REQUEST, err))?;
    if matches!(
        action,
        MachineAction::Add { .. } | MachineAction::Test { .. } | MachineAction::List {}
    ) {
        return Err(error(
            StatusCode::BAD_REQUEST,
            "use list or interactive setup endpoint",
        ));
    }
    let target = authorize_herdr_target_at_least(&query.name, MIN_MACHINE_AGENT_VERSION).await?;
    let _guard = mutation_lock(&target).try_lock_owned().map_err(|_| {
        error(
            StatusCode::CONFLICT,
            "machine catalog is busy; finish the current operation first",
        )
    })?;
    if matches!(action, MachineAction::Remove { .. }) {
        let catalog = request(&target, MachineAction::List {}).await?;
        action
            .check_removal(&catalog.machines)
            .map_err(|err| error(StatusCode::CONFLICT, err))?;
    }
    request(&target, action).await.map(Json)
}

async fn request(
    target: &AuthorizedHerdrTarget,
    action: MachineAction,
) -> Result<MachineCatalog, HerdrBridgeError> {
    let payload =
        serde_json::to_string(&action).map_err(|err| error(StatusCode::BAD_REQUEST, err))?;
    let mut command = target.agent.interactive_command(&[
        "herdr-machines",
        "--login-user",
        &target.login_user,
        "--request",
        &payload,
    ]);
    command
        .kill_on_drop(true)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|err| error(StatusCode::BAD_GATEWAY, err))?;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let mut out = child
        .stdout
        .take()
        .unwrap()
        .take((MAX_MACHINE_OUTPUT + 1) as u64);
    let mut err = child
        .stderr
        .take()
        .unwrap()
        .take((MAX_MACHINE_OUTPUT + 1) as u64);
    let operation = async {
        tokio::try_join!(
            out.read_to_end(&mut stdout),
            err.read_to_end(&mut stderr),
            child.wait()
        )
    };
    let (_, _, status) = timeout(Duration::from_secs(30), operation)
        .await
        .map_err(|_| {
            error(
                StatusCode::GATEWAY_TIMEOUT,
                "Herdr machine request timed out",
            )
        })?
        .map_err(|err| error(StatusCode::BAD_GATEWAY, err))?;
    if stdout.len() > MAX_MACHINE_OUTPUT || stderr.len() > MAX_MACHINE_OUTPUT {
        return Err(error(
            StatusCode::BAD_GATEWAY,
            "Herdr machine output limit exceeded",
        ));
    }
    if !status.success() {
        return Err(error(
            StatusCode::CONFLICT,
            String::from_utf8_lossy(&stderr).trim(),
        ));
    }
    serde_json::from_slice(&stdout).map_err(|err| {
        error(
            StatusCode::BAD_GATEWAY,
            format!("invalid Herdr machine response: {err}"),
        )
    })
}

pub(crate) async fn setup(
    headers: HeaderMap,
    Query(query): Query<HerdrQuery>,
    ws: WebSocketUpgrade,
) -> Response {
    if !origin_allowed(&headers) {
        return error(StatusCode::FORBIDDEN, "invalid websocket origin").into_response();
    }
    let Some(global_permit) = try_acquire_herdr_stream_permit(&HERDR_STREAM_CONNECTIONS) else {
        return error(StatusCode::TOO_MANY_REQUESTS, "too many Herdr connections").into_response();
    };
    let target = match authorize_herdr_target_at_least(&query.name, MIN_MACHINE_AGENT_VERSION).await
    {
        Ok(target) => target,
        Err(err) => return err.into_response(),
    };
    let Some(target_permit) =
        try_acquire_herdr_stream_permit(&herdr_target_stream_connections(&target.selector))
    else {
        return error(StatusCode::TOO_MANY_REQUESTS, "too many target connections").into_response();
    };
    ws.max_message_size(16 * 1024).max_frame_size(16 * 1024).on_upgrade(move |socket| async move {
        let _permits = (global_permit, target_permit);
        let (mut sender, mut receiver) = socket.split();
        let result = timeout(Duration::from_secs(MACHINE_SETUP_SECONDS + 15), async {
            let first = timeout(Duration::from_secs(10), receiver.next()).await?.ok_or_else(|| anyhow!("missing setup request"))??;
            let Message::Text(first) = first else { return Err(anyhow!("invalid setup request")); };
            let action: MachineAction = serde_json::from_str(&first)?;
            action.args()?;
            anyhow::ensure!(matches!(action, MachineAction::Add { .. } | MachineAction::Test { .. }), "only machine add supports setup");
            let _guard = if matches!(action, MachineAction::Test { .. }) { None } else { Some(mutation_lock(&target).try_lock_owned().map_err(|_| anyhow!("machine catalog is busy; finish the current operation first"))?) };
            let payload = serde_json::to_string(&action)?;
            let mut command = target.agent.interactive_command(&["herdr-machine-setup", "--login-user", &target.login_user, "--request", &payload]);
            command.kill_on_drop(true).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = command.spawn()?;
            let mut input = child.stdin.take().unwrap();
            let mut output = BufReader::new(child.stdout.take().unwrap());
            let mut stderr = child.stderr.take().unwrap().take((MAX_MACHINE_OUTPUT + 1) as u64);
            let stderr_task = tokio::spawn(async move { let mut bytes = Vec::new(); stderr.read_to_end(&mut bytes).await.map(|_| bytes) });
            let mut line = Vec::new();
            let mut chunk = [0; 4096];
            let mut total = 0;
            let result = async {
                loop {
                    tokio::select! {
                        count = output.read(&mut chunk) => {
                            let count = count?;
                            if count == 0 { break; }
                            total += count;
                            anyhow::ensure!(total <= MAX_MACHINE_OUTPUT * 2, "setup output limit exceeded");
                            for byte in &chunk[..count] {
                                line.push(*byte);
                                anyhow::ensure!(line.len() <= 16 * 1024, "setup line limit exceeded");
                                if *byte != b'\n' { continue; }
                                let value: Value = serde_json::from_slice(&line)?;
                                let finished = value.get("type").and_then(Value::as_str) == Some("exit");
                                send_herdr_socket_message(&mut sender, Message::Text(String::from_utf8(std::mem::take(&mut line))?.into())).await?;
                                if finished { return Ok(()); }
                            }
                        }
                        message = receiver.next() => match message {
                            Some(Ok(Message::Text(text))) => {
                                anyhow::ensure!(text.len() <= 16 * 1024 && !text.contains('\n'), "invalid setup input");
                                timeout(Duration::from_secs(5), async { input.write_all(text.as_bytes()).await?; input.write_all(b"\n").await }).await??;
                            }
                            Some(Ok(Message::Ping(payload))) => send_herdr_socket_message(&mut sender, Message::Pong(payload)).await?,
                            Some(Ok(Message::Pong(_))) => {}
                            _ => return Ok(()),
                        }
                    }
                }
                let bytes = stderr_task.await??;
                Err(anyhow!("{}", if bytes.is_empty() { "machine setup ended without a result".to_owned() } else { String::from_utf8_lossy(&bytes).trim().to_owned() }))
            }.await;
            // EOF reaches the target agent, whose own process-group guard cancels SSH.
            drop(input);
            let _ = timeout(Duration::from_secs(2), child.wait()).await;
            result
        }).await;
        let message = match result { Ok(Ok(())) => None, Ok(Err(err)) => Some(err.to_string()), Err(_) => Some("machine setup timed out".into()) };
        if let Some(message) = message {
            let _ = send_herdr_socket_message(&mut sender, Message::Text(json!({"type":"exit", "code":1, "message":message}).to_string().into())).await;
        }
        let _ = timeout(Duration::from_secs(2), sender.close()).await;
    }).into_response()
}
