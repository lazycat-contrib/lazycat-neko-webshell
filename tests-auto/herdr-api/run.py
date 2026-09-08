"""Exercise the allowlisted Herdr 0.9 APIs in an owned temporary server/repository."""
import json, os, socket, subprocess, tempfile, time, pathlib, shutil
binary = os.environ.get("HERDR_TEST_BINARY")
if not binary or not pathlib.Path(binary).is_file():
 raise SystemExit("Set HERDR_TEST_BINARY to an explicit Herdr 0.9.0+ binary")
binary = str(pathlib.Path(binary).resolve())
artifacts = pathlib.Path(__file__).resolve().parents[1] / "artifacts" / "herdr-api" / f"{time.time_ns()}-{os.getpid()}"
artifacts.mkdir(parents=True)
version = subprocess.run([binary, "--version"], check=True, capture_output=True, text=True, timeout=8).stdout.strip()

root=pathlib.Path(tempfile.mkdtemp(prefix='neko090-api-'));cfg=root/'config.toml';sock=root/'api.sock'
cfg.write_text('onboarding=false\n[terminal]\ndefault_shell="/bin/sh"\nshell_mode="non_login"\n[update]\nversion_check=false\nmanifest_check=false\n')
env={k:os.environ[k] for k in ['HOME','USER','LOGNAME','LANG'] if k in os.environ};env.update(PATH='/usr/bin:/bin',SHELL='/bin/sh',TERM='xterm-256color',HERDR_CONFIG_PATH=str(cfg),HERDR_SOCKET_PATH=str(sock),XDG_CONFIG_HOME=str(root/'xdg'))
child=subprocess.Popen([binary,'server'],env=env,cwd=root,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
seq=0
responses={}
def call(method,**params):
 global seq
 seq+=1
 with socket.socket(socket.AF_UNIX,socket.SOCK_STREAM) as s:
  s.settimeout(8);s.connect(str(sock));s.sendall((json.dumps({'id':str(seq),'method':method,'params':params})+'\n').encode());data=b''
  while b'\n' not in data:
   chunk=s.recv(65536)
   if not chunk:raise RuntimeError('API closed')
   data+=chunk
   if len(data)>1048576:raise RuntimeError('oversized API response')
  result=json.loads(data.split(b'\n',1)[0]);responses[method]=result
  if result.get('id') != str(seq):raise RuntimeError('mismatched response ID')
  return result
try:
 deadline=time.monotonic()+8
 while not sock.exists():
  if child.poll() not in (None, 0):raise RuntimeError('Herdr server startup failed')
  if time.monotonic()>deadline:raise RuntimeError('API startup timeout')
  time.sleep(.03)
 integrations=call('integration.list');assert 'result' in integrations,integrations
 created=call('workspace.create',label='API-smoke',cwd=str(root),focus=True);assert 'result' in created,created
 pane=created['result']['root_pane']['pane_id']
 call('pane.send_text',pane_id=pane,text="printf 'neko-%s\\n' 'history-smoke'\n")
 deadline=time.monotonic()+5
 while True:
  motion=call('pane.copy_motion',pane_id=pane,cursor={'row':0,'col':0},motion='first_non_blank')
  if 'result' in motion:
   state=motion['result'];revision=state['content_revision']
   if revision%2==0:
    search=call('pane.copy_search',pane_id=pane,query='neko-history-smoke',direction='forward',cursor=state['cursor'],content_revision=revision)
    if search.get('result',{}).get('total',0)>0:break
  if time.monotonic()>deadline:raise RuntimeError('search did not find real output: '+json.dumps(responses))
  time.sleep(.05)
 result=search['result'];hit=result['matches'][result['current']]
 selected=call('pane.selection.read',pane_id=pane,anchor=hit['start'],cursor=hit['end'],content_revision=revision)
 assert selected['result']['text']=='neko-history-smoke',selected
 print('integration.list + copy_motion -> copy_search -> selection.read: PASS')
 repo=root/'repo';repo.mkdir();subprocess.run(['git','init','-q',str(repo)],check=True,timeout=8)
 (repo/'test.txt').write_text('isolated test\n');subprocess.run(['git','-C',str(repo),'add','test.txt'],check=True,timeout=8);subprocess.run(['git','-C',str(repo),'-c','user.name=Test','-c','user.email=test@example.invalid','commit','-qm','test'],check=True,timeout=8)
 parent=call('workspace.create',cwd=str(repo),label='group-parent',focus=True);parentid=parent['result']['workspace']['workspace_id']
 worktree=call('worktree.create',workspace_id=parentid,branch='test-worktree',path=str(root/'worktree'),label='group-child',focus=False)
 assert 'result' in worktree,worktree
 members=call('workspace.list');single=call('workspace.close',workspace_id=parentid);assert single.get('error',{}).get('code')=='workspace_group_close_required',single
 grouped=call('workspace.close',workspace_id=parentid,close_group=True);assert 'result' in grouped,grouped
 print('workspace.close rejects group without consent; close_group:true closes isolated group: PASS')
 (artifacts/'metrics.json').write_text(json.dumps({'version':version,'integrations':integrations,'motion':motion,'search':search,'selection':selected,'groupMembers':members,'singleClose':single,'groupClose':grouped},indent=2))
 print('Artifacts: '+str(artifacts))
except Exception as error:
 (artifacts/'errors.json').write_text(json.dumps({'version':version,'error':str(error)},indent=2))
 raise
finally:
 try:call('server.stop')
 except Exception:
  subprocess.run([binary, 'server', 'stop'], env=env, cwd=root, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5, check=False)
 try:child.wait(timeout=4)
 except subprocess.TimeoutExpired:child.kill();child.wait(timeout=2)
 shutil.rmtree(root,ignore_errors=True)
