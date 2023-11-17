import { platform } from 'node:os'
import process from 'node:process'
import { chmodSync, createWriteStream, existsSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { got } from 'got-cjs'
import { HttpProxyAgent } from 'http-proxy-agent'
import { HttpsProxyAgent } from 'https-proxy-agent'
import * as hostile from 'hostile'
import kill from 'kill-port'
import { consola } from '../utils'
import { caddyPath, supportList } from './constants'
import { logProgress, logProgressOver, tryPort } from './utils'

export async function download() {
  if (await testCaddy())
    return caddyPath

  return new Promise<string>((resolve, reject) => {
    // https://caddyserver.com/api/download?os=darwin&arch=amd64

    const file = createWriteStream(caddyPath)

    let _platform = platform().toString()
    // win32 -> windows
    _platform === 'win32' && (_platform = 'windows')
    let _arch = process.arch.toString()
    // x64 -> amd64
    _arch === 'x64' && (_arch = 'amd64')

    const support = supportList.find(item => item.platform === _platform && item.arch === _arch)

    if (!support)
      return reject(new Error('not support'))

    const dowmloadLink = `https://caddyserver.com/api/download?os=${support.platform}&arch=${support.arch}`

    existsSync(caddyPath) && unlinkSync(caddyPath)

    const httpProxy = process.env.HTTP_PROXY || process.env.http_proxy
    const httpsProxy = process.env.HTTPS_PROXY || process.env.https_proxy

    const httpAgent = httpProxy ? new HttpProxyAgent(httpProxy) : undefined
    const httpsAgent = httpsProxy ? new HttpsProxyAgent(httpsProxy) : undefined

    got.stream(dowmloadLink, {
      agent: {
        http: httpAgent,
        https: httpsAgent,
      },
    }).on('downloadProgress', (progress) => {
      logProgress(progress.percent)
    }).pipe(file).on('finish', () => {
      logProgressOver()
      if (process.platform === 'win32')
        return resolve(caddyPath)
      // chmod +x
      chmodSync(caddyPath, 0o755)
      resolve(caddyPath)
    }).on('error', (err) => {
      // consola.error(err)
      reject(err)
    })
  })
}

function testCaddy() {
  return new Promise((resolve, reject) => {
    if (!existsSync(caddyPath))
      return resolve(false)
    chmodSync(caddyPath, 0o755)
    const child = process.platform === 'win32' ? spawn(caddyPath, []) : spawn('sudo', [caddyPath])
    child.on('close', () => {
      return resolve(false)
    })
    child.on('error', (err) => {
      return reject(err)
    })
    child.stdout.on('data', (_data) => {
      return resolve(true)
    })
  })
}

interface RunOptions {
  restore: boolean
  base: string
  showCaddyLog: boolean
}

export class CaddyInstant {
  private inited = false

  constructor() {
    testCaddy().then(() => {
      this.inited = true
    })
  }

  async init() {
    await download()
    this.inited = true
  }

  private async updateHost(ip: string, host: string) {
    ['localhost', '0.0.0.0'].includes(ip) && (ip = '127.0.0.1')
    return new Promise<boolean>((resolve, reject) => {
      hostile.set(ip, host, (err) => {
        if (err) {
          return reject(err)
        }
        else {
          if (process.platform === 'win32') {
            spawn('ipconfig', ['/flushdns']).on('error', (err) => {
              return reject(err)
            }).on('close', () => {
              resolve(true)
            })
          }
          else {
            spawn('sudo', ['killall', '-HUP', 'mDNSResponder']).on('error', (err) => {
              return reject(err)
            }).on('close', () => {
              resolve(true)
            })
          }
        }
      })
    })
  }

  private async restoreHost(ip: string, host: string) {
    ['localhost', '0.0.0.0'].includes(ip) && (ip = '127.0.0.1')
    return new Promise<boolean>((resolve, reject) => {
      hostile.remove(ip, host, (err) => {
        if (err) {
          return reject(err)
        }
        else {
          if (process.platform === 'win32') {
            spawn('ipconfig', ['/flushdns']).on('error', (err) => {
              return reject(err)
            }).on('close', () => {
              resolve(true)
            })
          }
          else {
            spawn('sudo', ['killall', '-HUP', 'mDNSResponder']).on('error', (err) => {
              return reject(err)
            }).on('close', () => {
              resolve(true)
            })
          }
        }
      })
    })
  }

  /**
   * @param source like `127.0.0.1:8080`
   * @param target like `test.abc.com`. And if you provide a port ,it will be ignore.
   * @returns
   */
  async run(source: string, target: string, options?: Partial<RunOptions>) {
    source = source.replace('0.0.0.0', '127.0.0.1').replace('localhost', '127.0.0.1')
    const {
      restore = true,
      base = '/',
      showCaddyLog = false,
    } = options || {}

    if (!this.inited)
      await this.init()

    if (!await this.updateHost(source.split(':')[0], target.split(':')[0]))
      throw new Error('update host failed')

    if (await tryPort(443))
      await kill(443, 'tcp')
    if (process.platform === 'win32' && await tryPort(80))
      await kill(80, 'tcp')

    return new Promise<() => Promise<void>>((resolve, reject) => {
      // caddy reverse-proxy --from target --to source --internal-certs
      const child = process.platform !== 'win32'
        ? spawn('sudo', [caddyPath, 'reverse-proxy', '--from', `${target.split(':')[0]}`, '--to', `${source}`, '--internal-certs'])
        : spawn(caddyPath, ['reverse-proxy', '--from', `${target.split(':')[0]}`, '--to', `${source}`, '--internal-certs'])

      child.on('error', (err) => {
        return reject(err)
      })

      child.stderr.on('data', (data) => {
        const lines = (data.toString() as string).split('\n').map(line => line.trim())
        for (const line of lines) {
          // caddy log
          // eslint-disable-next-line no-console
          showCaddyLog && line && console.info(line)
          if (line.includes('Error:') || (line && JSON.parse(line).level === 'error')) {
            consola.error(line)
            // child.kill()
            return reject(line)
          }
        }
      })

      child.stdout.on('data', (_data) => {
        consola.info(_data.toString())
        resolve(async () => {
          if (!restore)
            return

          if (await this.restoreHost(source.split(':')[0], target.split(':')[0]))
            consola.success('restore host success\n')

          else
            consola.fail('restore host failed\n')

          child.kill()
        })
      })
    })
  }
}
