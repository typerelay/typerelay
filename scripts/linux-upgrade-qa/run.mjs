import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createReadStream, constants } from 'node:fs'
import { homedir } from 'node:os'
import { basename, delimiter, isAbsolute, join, resolve } from 'node:path'
import { stdin } from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const targets = new Map([
    ['linux-x86_64-appimage', { distro: 'omarchy', kind: 'appimage', extension: '.AppImage' }],
    ['linux-x86_64-deb', { distro: 'debian', kind: 'deb', extension: '.deb' }],
    ['linux-x86_64-rpm', { distro: 'fedora', kind: 'rpm', extension: '.rpm' }],
])
const cache = resolve(process.env.TYPERELAY_LINUX_QA_DIR || join(homedir(), '.cache/typerelay/linux-upgrade-qa'))
const guestScript = fileURLToPath(new URL('./guest.sh', import.meta.url))
const fixture = join(cache, 'legacy-profile.tar.gz')
const env = { ...process.env, PATH: [join(cache, 'bin'), process.env.PATH].join(delimiter) }
const exec = promisify(execFile)
const cancelled = new AbortController()

function command(binary, args, cwd, timeout = 15_000) {
    return exec(binary, args, { cwd, env, timeout, killSignal: 'SIGKILL', signal: cancelled.signal })
}

async function readCandidate() {
    let input = ''
    stdin.setEncoding('utf8')
    for await (const chunk of stdin) {
        input += chunk
        if (input.length > 64 * 1024) throw new Error('QA candidate exceeds 64 KiB')
    }
    const candidate = JSON.parse(input)
    if (typeof candidate?.version !== 'string' || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?$/.test(candidate.version)) throw new Error('QA requires a valid candidate version')
    if (!Array.isArray(candidate.packages) || candidate.packages.length !== targets.size) throw new Error('QA requires exactly one AppImage, Debian package and RPM')

    const seen = new Set()
    for (const item of candidate.packages) {
        const target = targets.get(item?.target)
        if (!target || seen.has(item.target)) throw new Error('QA package targets are missing, unexpected or repeated')
        seen.add(item.target)
        if (typeof item.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(item.name) || !item.name.endsWith(target.extension)) throw new Error(`Invalid ${item.target} package name`)
        if (typeof item.filePath !== 'string' || !isAbsolute(item.filePath) || basename(item.filePath) !== item.name || !(await stat(item.filePath)).isFile()) throw new Error(`Invalid ${item.target} package path`)
        if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error(`Invalid ${item.target} SHA-256`)
        const hash = createHash('sha256')
        for await (const chunk of createReadStream(item.filePath, { signal: cancelled.signal })) hash.update(chunk)
        if (hash.digest('hex') !== item.sha256) throw new Error(`${item.name} does not match the candidate SHA-256`)
    }
    return candidate
}

async function makeSeed(work, socket) {
    for (const key of ['client', 'host']) await command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'typerelay-qa', '-f', key], work)
    const clientKey = (await readFile(join(work, 'client.pub'), 'utf8')).trim()
    const hostKey = (await readFile(join(work, 'host.pub'), 'utf8')).trim()
    const hostPrivate = (await readFile(join(work, 'host'), 'utf8')).trim().replace(/^/gm, '    ')
    await writeFile(join(work, 'meta-data'), `instance-id: typerelay-qa-${randomUUID()}\n`, { mode: 0o600 })
    await writeFile(join(work, 'network-config'), `version: 2
ethernets:
  qanet:
    match:
      macaddress: "52:54:00:12:34:56"
    dhcp4: false
    dhcp6: false
    addresses: [10.0.2.15/24]
`, { mode: 0o600 })
    await writeFile(join(work, 'user-data'), `#cloud-config
users:
  - name: relayqa
    shell: /bin/bash
    sudo: ALL=(ALL) NOPASSWD:ALL
    ssh_authorized_keys:
      - ${clientKey}
ssh_pwauth: false
ssh_keys:
  ed25519_private: |
${hostPrivate}
  ed25519_public: ${hostKey}
`, { mode: 0o600 })
    await writeFile(join(work, 'known_hosts'), `typerelay-qa ${hostKey}\n`, { mode: 0o600 })
    await writeFile(join(work, 'ssh_config'), `Host typerelay-qa
  User relayqa
  ProxyCommand nc -U ${socket}
  IdentityFile "${join(work, 'client')}"
  IdentitiesOnly yes
  BatchMode yes
  ConnectTimeout 3
  ServerAliveInterval 5
  ServerAliveCountMax 2
  StrictHostKeyChecking yes
  GlobalKnownHostsFile /dev/null
  UserKnownHostsFile "${join(work, 'known_hosts')}"
`, { mode: 0o600 })
    await command('bsdtar', ['-cf', 'seed.iso', '--format', 'iso9660', '--options', 'volume-id=cidata', 'meta-data', 'network-config', 'user-data'], work)
}

async function bootCheck(item, version, logs) {
    const { distro, kind } = targets.get(item.target)
    const work = await mkdtemp('/tmp/typerelay-qa-')
    const socket = join(work, 'ssh.sock')
    const base = join(cache, `${distro}.qcow2`)
    const messages = []
    const log = message => {
        messages.push(message)
        console.error(`[${distro}] ${message}`)
    }
    let vm
    let vmClosed
    let vmFailure
    try {
        const image = await stat(base)
        if (!image.isFile() || (image.mode & 0o222)) throw new Error(`${base} must be a read-only qcow2 base image`)
        const { stdout: info } = await command('qemu-img', ['info', '-f', 'qcow2', '--output=json', base], work)
        const baseInfo = JSON.parse(info)
        if (baseInfo['backing-filename'] || baseInfo['format-specific']?.data?.['data-file']) throw new Error(`${base} must be a standalone qcow2 base image`)
        await makeSeed(work, socket)
        await command('qemu-img', ['create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', base, 'overlay.qcow2'], work)
        cancelled.signal.throwIfAborted()
        const output = await open(join(work, 'qemu.log'), 'w', 0o600)
        try {
            vm = spawn('qemu-system-x86_64', [
                '-name', `typerelay-qa-${distro}`, '-accel', 'kvm', '-cpu', 'host', '-m', '3072', '-smp', '2',
                '-run-with', 'exit-with-parent=on',
                '-display', 'none', '-monitor', 'none', '-serial', 'file:serial.log', '-no-reboot',
                '-drive', 'file=overlay.qcow2,if=virtio,format=qcow2',
                '-drive', 'file=seed.iso,media=cdrom,readonly=on,format=raw',
                '-nic', `user,model=virtio-net-pci,mac=52:54:00:12:34:56,restrict=on,ipv6=off,hostfwd=unix:${socket}-10.0.2.15:22`,
            ], { cwd: work, env, stdio: ['ignore', output.fd, output.fd] })
            vm.on('error', error => { vmFailure = error })
            vmClosed = new Promise(resolve => vm.once('close', resolve))
        } finally {
            await output.close()
        }
        log('Booting prepared guest')
        const config = ['-F', join(work, 'ssh_config')]
        const started = Date.now()
        for (;;) {
            cancelled.signal.throwIfAborted()
            if (vmFailure) throw vmFailure
            if (vm.exitCode !== null || vm.signalCode !== null) throw new Error('QEMU stopped during boot')
            try {
                await command('ssh', [...config, 'typerelay-qa', 'sudo -n true'], work, 6_000)
                break
            } catch (error) {
                if (Date.now() - started >= 90_000) throw new Error(`SSH did not become ready: ${error.stderr || error.message}`)
                await sleep(750, undefined, { signal: cancelled.signal })
            }
        }

        await command('scp', [...config, item.filePath, guestScript, fixture, 'typerelay-qa:/home/relayqa/'], work, 90_000)
        const { stdout, stderr } = await command('ssh', [
            ...config, 'typerelay-qa', 'bash', '/home/relayqa/guest.sh', kind, version,
            `/home/relayqa/${item.name}`, item.sha256, '/home/relayqa/legacy-profile.tar.gz',
        ], work, 300_000)
        if (stdout.trim()) log(stdout.trim())
        if (stderr.trim()) log(stderr.trim())
        log('Upgrade checks passed')
    } catch (error) {
        log(error.message)
        for (const output of [error.stdout, error.stderr]) {
            if (output?.trim()) log(output.trim())
        }
        for (const filename of ['qemu.log', 'serial.log']) {
            const output = await readFile(join(work, filename), 'utf8').catch(() => '')
            if (output.trim()) log(`${filename}\n${output.trim().split('\n').slice(-20).join('\n')}`)
        }
        throw error
    } finally {
        if (vm) {
            vm.kill()
            await Promise.race([vmClosed, sleep(2_000, undefined, { ref: false })])
            if (vm.exitCode === null && vm.signalCode === null) vm.kill('SIGKILL')
            await vmClosed
        }
        try {
            await writeFile(join(logs, `${distro}-check.log`), messages.join('\n') + '\n', { mode: 0o600 })
            for (const name of ['qemu.log', 'serial.log']) {
                await copyFile(join(work, name), join(logs, `${distro}-${name}`)).catch(error => {
                    if (error.code !== 'ENOENT') throw error
                })
            }
        } finally {
            await rm(work, { recursive: true, force: true })
        }
    }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
        process.exitCode = 1
        cancelled.abort(new Error(`QA interrupted by ${signal}`))
        stdin.destroy()
    })
}

try {
    const candidate = await readCandidate()
    await Promise.all([access('/dev/kvm', constants.R_OK | constants.W_OK), access(fixture, constants.R_OK)])
    const logRoot = join(cache, 'logs')
    await mkdir(logRoot, { recursive: true, mode: 0o700 })
    const logs = await mkdtemp(join(logRoot, `${candidate.version}-`))
    console.error(`Linux upgrade QA logs: ${logs}`)
    const results = await Promise.allSettled(candidate.packages.map(item => bootCheck(item, candidate.version, logs)))
    for (const result of results) {
        if (result.status === 'rejected') {
            console.error(`Linux upgrade QA: ${result.reason.message}`)
            process.exitCode = 1
        }
    }
} catch (error) {
    console.error(`Linux upgrade QA: ${error.message}`)
    process.exitCode = 1
}
