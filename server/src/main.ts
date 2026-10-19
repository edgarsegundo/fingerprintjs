import { loadConfig } from './config'
import { startServer } from './server'

const configFile = process.env.FP_CONFIG ?? process.argv[2]
if (!configFile) {
  process.stderr.write(
    'Usage: FP_CONFIG=/path/to/config.json node server/dist/main.js\n' +
      '   or: node server/dist/main.js /path/to/config.json\n',
  )
  process.exit(2)
}

const log = (entry: Record<string, unknown>) =>
  process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`)

startServer(loadConfig(configFile), { log })
  .then((server) => {
    log({ route: 'started', port: server.port })
    // `kill -HUP <pid>` reads the file again. A mistake in the new file is refused and the old settings stay.
    process.on('SIGHUP', () => {
      Promise.resolve()
        .then(() => server.reloadConfig(loadConfig(configFile)))
        .then(() => log({ route: 'config_reloaded' }))
        .catch((error: unknown) =>
          log({ route: 'config_reload_failed', error: error instanceof Error ? error.message : 'unknown' }),
        )
    })
    let stopping = false
    const shutdown = () => {
      if (stopping) {
        return
      }
      stopping = true
      log({ route: 'stopping' })
      // A connection that will not end must not keep the process from stopping
      setTimeout(() => {
        log({ route: 'stop_forced' })
        process.exit(1)
      }, 15_000).unref()
      server.close().finally(() => process.exit(0))
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  })
  .catch((error: unknown) => {
    process.stderr.write(`Failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
