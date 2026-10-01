// Plugin entry: runs `npx -y agency-dev <args>` on any OS (npx is a .cmd shim on Windows), piping stdio through.
const { spawn } = require('node:child_process');
const p = spawn('npx', ['-y', 'agency-dev', ...process.argv.slice(2)], { stdio: 'inherit', shell: process.platform === 'win32' });
p.on('exit', (c) => process.exit(c ?? 0));
