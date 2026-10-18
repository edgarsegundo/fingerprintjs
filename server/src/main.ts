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
    const shutdown = () => {
      log({ route: 'stopping' })
      server.close().finally(() => process.exit(0))
    }
    process.on('SIGTERM', shutdown)
    process.on('SIGINT', shutdown)
  })
  .catch((error: unknown) => {
    process.stderr.write(`Failed to start: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
