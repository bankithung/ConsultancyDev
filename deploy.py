from pathlib import Path
import subprocess, shutil, datetime, fcntl
stage=Path('/root/consultancy-permission-control')
live=Path('/opt/consultancy')
files=subprocess.check_output(['git','diff','--name-only'],cwd=stage,text=True).splitlines()
assert files and all(p.startswith(('backend/core/','backend/mcp_server/','docs/mcp/')) for p in files)
def run(*cmd): subprocess.run(cmd,cwd=live/'backend',check=True)
with open('/tmp/consultancy-autodeploy.lock','a') as lock:
    fcntl.flock(lock,fcntl.LOCK_EX)
    for name in files:
        assert (live/name).read_bytes()==subprocess.check_output(['git','show','HEAD:'+name],cwd=stage), name
    backup=Path('/root/consultancy-permission-backup-'+datetime.datetime.now().strftime('%Y%m%dT%H%M%S'))
    for name in files:
        (backup/name).parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(live/name,backup/name)
    try:
        for name in files: shutil.copy2(stage/name,live/name)
        run('/opt/consultancy/backend/venv/bin/python','manage.py','check')
        run('systemctl','restart','consultancy-backend','consultancy-mcp')
        run('systemctl','is-active','consultancy-backend','consultancy-mcp','consultancy-frontend')
    except Exception:
        for name in files: shutil.copy2(backup/name,live/name)
        run('systemctl','restart','consultancy-backend','consultancy-mcp')
        raise
    print('Deployed',len(files),'files. Backup:',backup)
