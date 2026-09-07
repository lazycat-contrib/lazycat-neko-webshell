use std::sync::OnceLock;
use std::time::Instant;

use anyhow::{Context as _, anyhow, bail};
use sha2::{Digest as _, Sha256};
use wasmi::{
    Caller, CompilationMode, Config, Engine, ExternType, Linker, Memory, Module, Store,
    StoreLimits, StoreLimitsBuilder, TypedFunc, ValType,
};

use crate::config::{MAX_COLS, MAX_ROWS};

const RESTTY_WASM: &[u8] = include_bytes!("../vendor/restty/0.3.0/restty.wasm");
const RESTTY_WASM_SHA256: &str = "2ac53b6ee3ea00f1b4e122cf4fa9ef3f18c5ca7e8a8dd288e8575b87626566f9";
const MAX_WASM_WRITE_BYTES: usize = 1024 * 1024;
const MAX_WASM_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_WASM_MEMORY_BYTES: usize = 16 * 1024 * 1024;
const MAX_WASM_FUEL_PER_OPERATION: u64 = 100_000_000;
// Match the PTY reader cadence so complex full-screen redraws cannot spend an entire
// batched frame's fuel in one WASM call. The input is sliced without copying.
const MAX_WASM_FUEL_INPUT_CHUNK_BYTES: usize = 8 * 1024;

static COMPILED_RESTTY: OnceLock<Result<CompiledRestty, String>> = OnceLock::new();

#[derive(Clone, Debug)]
struct CompiledRestty {
    engine: Engine,
    module: Module,
}

struct WasmStoreState {
    limits: StoreLimits,
    clock_origin: Instant,
}

pub struct ResttyHeadlessTerminal {
    store: Store<WasmStoreState>,
    memory: Memory,
    handle: i32,
    destroy: TypedFunc<i32, ()>,
    write: TypedFunc<(i32, i32, i32), i32>,
    resize: TypedFunc<(i32, i32, i32), i32>,
    alloc: TypedFunc<i32, i32>,
    free: TypedFunc<(i32, i32), ()>,
    output_ptr: TypedFunc<i32, i32>,
    output_len: TypedFunc<i32, i32>,
    output_consume: TypedFunc<(i32, i32), i32>,
}

impl ResttyHeadlessTerminal {
    pub fn new(cols: u16, rows: u16) -> anyhow::Result<Self> {
        validate_dimensions(cols, rows)?;
        let compiled = compiled_restty()?;
        let limits = StoreLimitsBuilder::new()
            .memory_size(MAX_WASM_MEMORY_BYTES)
            .table_elements(100_000)
            .instances(1)
            .tables(1)
            .memories(1)
            .trap_on_grow_failure(true)
            .build();
        let mut store = Store::new(
            &compiled.engine,
            WasmStoreState {
                limits,
                clock_origin: Instant::now(),
            },
        );
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(MAX_WASM_FUEL_PER_OPERATION)
            .context("failed to set Restty initialization fuel")?;
        let mut linker = <Linker<WasmStoreState>>::new(&compiled.engine);
        linker
            .func_wrap(
                "env",
                "now_ms",
                |caller: Caller<'_, WasmStoreState>| -> f64 { monotonic_now_ms(caller.data()) },
            )
            .context("failed to link Restty env.now_ms")?;
        let instance = linker
            .instantiate_and_start(&mut store, &compiled.module)
            .context("failed to instantiate Restty WASM")?;
        let memory = instance
            .get_memory(&store, "memory")
            .ok_or_else(|| anyhow!("Restty WASM does not export memory"))?;
        let create = instance
            .get_typed_func(&store, "restty_create")
            .context("invalid restty_create ABI")?;
        let destroy = instance
            .get_typed_func(&store, "restty_destroy")
            .context("invalid restty_destroy ABI")?;
        let write = instance
            .get_typed_func(&store, "restty_write")
            .context("invalid restty_write ABI")?;
        let resize = instance
            .get_typed_func(&store, "restty_resize")
            .context("invalid restty_resize ABI")?;
        let alloc = instance
            .get_typed_func(&store, "restty_alloc")
            .context("invalid restty_alloc ABI")?;
        let free = instance
            .get_typed_func(&store, "restty_free")
            .context("invalid restty_free ABI")?;
        let output_ptr = instance
            .get_typed_func(&store, "restty_output_ptr")
            .context("invalid restty_output_ptr ABI")?;
        let output_len = instance
            .get_typed_func(&store, "restty_output_len")
            .context("invalid restty_output_len ABI")?;
        let output_consume = instance
            .get_typed_func(&store, "restty_output_consume")
            .context("invalid restty_output_consume ABI")?;
        store
            .set_fuel(MAX_WASM_FUEL_PER_OPERATION)
            .context("failed to set Restty creation fuel")?;
        let handle = create
            .call(&mut store, (i32::from(cols), i32::from(rows), 0))
            .context("Restty terminal creation trapped")?;
        if handle == 0 {
            bail!("Restty terminal creation returned a null handle");
        }
        Ok(Self {
            store,
            memory,
            handle,
            destroy,
            write,
            resize,
            alloc,
            free,
            output_ptr,
            output_len,
            output_consume,
        })
    }

    pub fn write_output(&mut self, bytes: &[u8]) -> anyhow::Result<Vec<u8>> {
        if bytes.len() > MAX_WASM_WRITE_BYTES {
            bail!("Restty write exceeds {MAX_WASM_WRITE_BYTES} bytes");
        }
        let mut output = Vec::new();
        for chunk in bytes.chunks(MAX_WASM_FUEL_INPUT_CHUNK_BYTES) {
            self.write(chunk)?;
            let reply = self.drain_output()?;
            if output.len().saturating_add(reply.len()) > MAX_WASM_OUTPUT_BYTES {
                bail!("Restty generated output exceeds {MAX_WASM_OUTPUT_BYTES} bytes");
            }
            output.extend(reply);
        }
        Ok(output)
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.ensure_alive()?;
        validate_dimensions(cols, rows)?;
        self.replenish_fuel()?;
        self.resize
            .call(
                &mut self.store,
                (self.handle, i32::from(cols), i32::from(rows)),
            )
            .map(|_| ())
            .context("Restty resize trapped")
    }

    pub fn drain_output(&mut self) -> anyhow::Result<Vec<u8>> {
        self.ensure_alive()?;
        self.replenish_fuel()?;
        let length = self
            .output_len
            .call(&mut self.store, self.handle)
            .context("Restty output length trapped")?;
        if length == 0 {
            return Ok(Vec::new());
        }
        let length = usize::try_from(length).context("Restty returned a negative output length")?;
        if length > MAX_WASM_OUTPUT_BYTES {
            bail!("Restty generated output exceeds {MAX_WASM_OUTPUT_BYTES} bytes");
        }
        let pointer = self
            .output_ptr
            .call(&mut self.store, self.handle)
            .context("Restty output pointer trapped")?;
        let pointer =
            usize::try_from(pointer).context("Restty returned a negative output pointer")?;
        if pointer == 0 {
            bail!("Restty returned a null output pointer for {length} bytes");
        }
        let mut output = vec![0_u8; length];
        self.memory
            .read(&self.store, pointer, &mut output)
            .context("Restty output was outside WASM memory")?;
        self.output_consume
            .call(
                &mut self.store,
                (
                    self.handle,
                    i32::try_from(length).context("Restty output length does not fit the ABI")?,
                ),
            )
            .map(|_| ())
            .context("Restty output consume trapped")?;
        Ok(output)
    }

    pub fn dispose(&mut self) {
        if self.handle == 0 {
            return;
        }
        let handle = std::mem::take(&mut self.handle);
        let _ = self.store.set_fuel(MAX_WASM_FUEL_PER_OPERATION);
        let _ = self.destroy.call(&mut self.store, handle);
    }

    fn write(&mut self, bytes: &[u8]) -> anyhow::Result<()> {
        self.ensure_alive()?;
        if bytes.is_empty() {
            return Ok(());
        }
        if bytes.len() > MAX_WASM_WRITE_BYTES {
            bail!("Restty write exceeds {MAX_WASM_WRITE_BYTES} bytes");
        }
        self.replenish_fuel()?;
        let length =
            i32::try_from(bytes.len()).context("Restty write length does not fit the ABI")?;
        let pointer = self
            .alloc
            .call(&mut self.store, length)
            .context("Restty allocation trapped")?;
        if pointer == 0 {
            bail!("Restty allocation returned a null pointer");
        }
        let offset =
            usize::try_from(pointer).context("Restty returned a negative allocation pointer")?;
        let result = self
            .memory
            .write(&mut self.store, offset, bytes)
            .context("Restty input was outside WASM memory")
            .and_then(|()| {
                self.write
                    .call(&mut self.store, (self.handle, pointer, length))
                    .map(|_| ())
                    .context("Restty write trapped")
            });
        let free_result = self
            .free
            .call(&mut self.store, (pointer, length))
            .context("Restty free trapped");
        result.and(free_result)
    }

    fn replenish_fuel(&mut self) -> anyhow::Result<()> {
        self.store
            .set_fuel(MAX_WASM_FUEL_PER_OPERATION)
            .context("failed to replenish Restty execution fuel")
    }

    fn ensure_alive(&self) -> anyhow::Result<()> {
        if self.handle == 0 {
            bail!("Restty terminal is disposed");
        }
        Ok(())
    }
}

impl Drop for ResttyHeadlessTerminal {
    fn drop(&mut self) {
        self.dispose();
    }
}

fn compiled_restty() -> anyhow::Result<&'static CompiledRestty> {
    COMPILED_RESTTY
        .get_or_init(|| compile_artifact(RESTTY_WASM).map_err(|error| error.to_string()))
        .as_ref()
        .map_err(|message| anyhow!(message.clone()))
}

fn compile_artifact(bytes: &[u8]) -> anyhow::Result<CompiledRestty> {
    validate_artifact(bytes)?;
    let mut config = Config::default();
    config.compilation_mode(CompilationMode::Eager);
    config.consume_fuel(true);
    config.wasm_simd(true);
    config.wasm_relaxed_simd(false);
    let engine = Engine::new(&config);
    let module = Module::new(&engine, bytes).context("failed to compile Restty WASM")?;
    validate_host_import(&module)?;
    Ok(CompiledRestty { engine, module })
}

fn validate_host_import(module: &Module) -> anyhow::Result<()> {
    let mut imports = module.imports();
    let import = imports
        .next()
        .ok_or_else(|| anyhow!("Restty WASM is missing env.now_ms"))?;
    if imports.next().is_some() {
        bail!("Restty WASM must import only env.now_ms");
    }
    if import.module() != "env" || import.name() != "now_ms" {
        bail!(
            "unexpected Restty WASM import: {}.{}",
            import.module(),
            import.name()
        );
    }
    let ExternType::Func(function) = import.ty() else {
        bail!("Restty WASM env.now_ms import is not a function");
    };
    if !function.params().is_empty() || function.results() != [ValType::F64] {
        bail!(
            "invalid Restty WASM env.now_ms ABI: expected () -> f64, found {:?} -> {:?}",
            function.params(),
            function.results()
        );
    }
    Ok(())
}

fn validate_artifact(bytes: &[u8]) -> anyhow::Result<()> {
    const WASM_V1_MAGIC: &[u8] = b"\0asm\x01\0\0\0";
    if !bytes.starts_with(WASM_V1_MAGIC) {
        bail!("Restty artifact is not a WebAssembly v1 module");
    }
    let digest = hex_lower(&Sha256::digest(bytes));
    if digest != RESTTY_WASM_SHA256 {
        bail!("Restty artifact SHA-256 mismatch");
    }
    Ok(())
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(&mut output, "{byte:02x}");
    }
    output
}

fn monotonic_now_ms(state: &WasmStoreState) -> f64 {
    state.clock_origin.elapsed().as_secs_f64() * 1_000.0
}

fn validate_dimensions(cols: u16, rows: u16) -> anyhow::Result<()> {
    if cols == 0 || cols > MAX_COLS || rows == 0 || rows > MAX_ROWS {
        bail!("terminal size must be between 1x1 and {MAX_COLS}x{MAX_ROWS}");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::hint::black_box;
    use std::time::{Duration, Instant};

    use super::*;
    use crate::config::{
        PTY_OUTPUT_BATCH_BYTES, PTY_OUTPUT_BATCH_INTERVAL_MS, PTY_OUTPUT_READ_BYTES,
    };

    #[test]
    fn validates_the_pinned_wasm_artifact() {
        validate_artifact(RESTTY_WASM).expect("pinned Restty WASM must validate");
        compile_artifact(RESTTY_WASM).expect("pinned Restty WASM contract must validate");
        assert_eq!(RESTTY_WASM.len(), 1_058_249);
    }

    #[test]
    fn rejects_an_invalid_wasm_artifact() {
        let error = compile_artifact(b"not wasm").expect_err("invalid artifact must fail");
        assert!(error.to_string().contains("WebAssembly v1"));
    }

    #[test]
    fn rejects_a_wasm_artifact_with_the_wrong_hash() {
        let mut bytes = RESTTY_WASM.to_vec();
        let last = bytes.last_mut().expect("pinned WASM is non-empty");
        *last ^= 0x01;

        let error = validate_artifact(&bytes).expect_err("modified artifact must fail");
        assert!(error.to_string().contains("SHA-256"));
    }

    #[test]
    fn validates_the_now_ms_import_and_rejects_wrong_imports_or_abi() {
        let correct = test_now_ms_import_module();
        let module = test_module(&correct);
        validate_host_import(&module).expect("() -> f64 env.now_ms import must validate");

        let mut wrong_name = correct.clone();
        wrong_name[23] = b'x';
        let error = validate_host_import(&test_module(&wrong_name))
            .expect_err("unexpected import name must fail");
        assert!(error.to_string().contains("unexpected Restty WASM import"));

        let mut wrong_abi = correct;
        wrong_abi[14] = 0x7e;
        let error = validate_host_import(&test_module(&wrong_abi))
            .expect_err("non-f64 clock result must fail");
        assert!(error.to_string().contains("expected () -> f64"));
    }

    #[test]
    fn now_ms_is_monotonic_from_each_store_origin() {
        let state = WasmStoreState {
            limits: StoreLimitsBuilder::new().build(),
            clock_origin: Instant::now(),
        };
        let first = monotonic_now_ms(&state);
        std::thread::sleep(Duration::from_millis(1));
        let second = monotonic_now_ms(&state);

        assert!(first.is_finite() && first >= 0.0);
        assert!(second > first);
    }

    fn test_module(bytes: &[u8]) -> Module {
        let engine = Engine::default();
        Module::new(&engine, bytes).expect("test WebAssembly module must compile")
    }

    fn test_now_ms_import_module() -> Vec<u8> {
        vec![
            0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, // WebAssembly v1.
            0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7c, // Type 0: () -> f64.
            0x02, 0x0e, 0x01, 0x03, b'e', b'n', b'v', 0x06, b'n', b'o', b'w', b'_', b'm', b's',
            0x00, 0x00, // Function import env.now_ms with type 0.
        ]
    }

    #[test]
    fn caps_each_headless_wasm_instance_memory() {
        const WASM_PAGE_BYTES: usize = 64 * 1024;

        let mut terminal = ResttyHeadlessTerminal::new(80, 24).expect("create headless terminal");
        let current_bytes = terminal.memory.data_size(&terminal.store);
        let pages_past_limit =
            u64::try_from((MAX_WASM_MEMORY_BYTES - current_bytes) / WASM_PAGE_BYTES + 1)
                .expect("memory page count");

        assert!(
            terminal
                .memory
                .grow(&mut terminal.store, pages_past_limit)
                .is_err()
        );
        assert!(terminal.memory.data_size(&terminal.store) <= MAX_WASM_MEMORY_BYTES);
    }

    #[test]
    fn generates_cursor_position_replies_once() {
        let mut terminal = ResttyHeadlessTerminal::new(80, 24).expect("create headless terminal");

        let reply = terminal
            .write_output(b"\x1b[6n")
            .expect("write cursor query");
        assert_eq!(reply, b"\x1b[1;1R");
        assert!(
            terminal
                .drain_output()
                .expect("drain output again")
                .is_empty()
        );
    }

    #[test]
    fn tracks_utf8_output_and_cursor_position_after_resize() {
        let mut terminal = ResttyHeadlessTerminal::new(80, 24).expect("create headless terminal");
        assert!(
            terminal
                .write_output("你好".as_bytes())
                .expect("write UTF-8")
                .is_empty()
        );
        terminal.resize(120, 40).expect("resize terminal");

        let reply = terminal
            .write_output(b"\x1b[6n")
            .expect("write cursor query");
        assert_eq!(reply, b"\x1b[1;5R");
    }

    #[test]
    fn accepts_the_maximum_pty_output_batch_within_the_fuel_budget() {
        let mut terminal = ResttyHeadlessTerminal::new(120, 40).expect("create headless terminal");
        let output = vec![b'x'; PTY_OUTPUT_BATCH_BYTES];

        assert!(
            terminal
                .write_output(&output)
                .expect("parse maximum PTY batch")
                .is_empty()
        );
    }

    #[test]
    fn accepts_a_herdr_style_full_screen_output_batch() {
        let mut output = Vec::with_capacity(PTY_OUTPUT_BATCH_BYTES);
        while output.len() < PTY_OUTPUT_BATCH_BYTES {
            for row in 1..=49 {
                for col in 1..=193 {
                    output.extend_from_slice(
                        format!("\x1b[{row};{col}H\x1b[0;38;2;237;242;247;48;2;5;10;18mx")
                            .as_bytes(),
                    );
                    if output.len() >= PTY_OUTPUT_BATCH_BYTES {
                        break;
                    }
                }
                if output.len() >= PTY_OUTPUT_BATCH_BYTES {
                    break;
                }
            }
        }
        output.truncate(PTY_OUTPUT_BATCH_BYTES);

        let mut terminal = ResttyHeadlessTerminal::new(193, 49).expect("create headless terminal");
        assert!(
            terminal
                .write_output(&output)
                .expect("parse Herdr-style full-screen output")
                .is_empty()
        );
    }

    #[test]
    fn disposed_terminals_reject_further_writes() {
        let mut terminal = ResttyHeadlessTerminal::new(80, 24).expect("create headless terminal");
        terminal.dispose();
        terminal.dispose();

        let error = terminal
            .write_output(b"test")
            .expect_err("disposed terminal must fail");
        assert!(error.to_string().contains("disposed"));
    }

    #[test]
    #[ignore = "release-mode performance gate"]
    fn headless_parsing_stays_within_the_output_batch_overhead_budget() {
        const SAMPLE_COUNT: usize = 15;
        const MAX_OVERHEAD_RATIO: f64 = 1.25;

        let mut input = Vec::with_capacity(PTY_OUTPUT_READ_BYTES);
        let line = b"\x1b[38;5;45mrestty performance check\x1b[0m\r\n";
        while input.len() < PTY_OUTPUT_READ_BYTES {
            input.extend_from_slice(line);
        }
        input.truncate(PTY_OUTPUT_READ_BYTES);

        let mut terminal = ResttyHeadlessTerminal::new(120, 40).expect("create headless terminal");
        terminal
            .write_output(&input)
            .expect("warm Restty headless parser");

        let mut raw_samples = Vec::with_capacity(SAMPLE_COUNT);
        let mut headless_samples = Vec::with_capacity(SAMPLE_COUNT);
        for _ in 0..SAMPLE_COUNT {
            let started = Instant::now();
            let published = black_box(input.clone());
            black_box(published);
            raw_samples.push(started.elapsed());

            let started = Instant::now();
            let reply = terminal
                .write_output(black_box(&input))
                .expect("parse representative output batch");
            assert!(reply.is_empty());
            headless_samples.push(started.elapsed());
        }

        raw_samples.sort_unstable();
        headless_samples.sort_unstable();
        let raw = raw_samples[SAMPLE_COUNT / 2];
        let headless = headless_samples[SAMPLE_COUNT / 2];
        let cadence = Duration::from_millis(PTY_OUTPUT_BATCH_INTERVAL_MS);
        let ratio = (cadence + headless).as_secs_f64() / (cadence + raw).as_secs_f64();
        let input_bytes = u32::try_from(input.len()).expect("benchmark input fits u32");
        let throughput_mib = f64::from(input_bytes) / headless.as_secs_f64() / (1024.0 * 1024.0);

        eprintln!(
            "Restty headless median: {headless:?}; raw publish: {raw:?}; cadence overhead: {ratio:.3}x; throughput: {throughput_mib:.1} MiB/s"
        );
        assert!(
            ratio <= MAX_OVERHEAD_RATIO,
            "headless output path overhead {ratio:.3}x exceeds {MAX_OVERHEAD_RATIO:.2}x"
        );
    }
}
