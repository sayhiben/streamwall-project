import TOML from '@iarna/toml'
import * as Sentry from '@sentry/electron/main'
import { BrowserWindow, app, session } from 'electron'
import started from 'electron-squirrel-startup'
import fs from 'fs'
import { throttle } from 'lodash-es'
import EventEmitter from 'node:events'
import { join } from 'node:path'
import ReconnectingWebSocket from 'reconnecting-websocket'
import 'source-map-support/register'
import { ControlCommand, StreamwallState } from 'streamwall-shared'
import { updateElectronApp } from 'update-electron-app'
import WebSocket from 'ws'
import yargs from 'yargs'
import * as Y from 'yjs'
import { ensureValidURL } from '../util'
import ControlWindow from './ControlWindow'
import {
  LocalStreamData,
  StreamIDGenerator,
  combineDataSources,
  markDataSource,
  pollDataURL,
  watchDataFile,
} from './data'
import { loadStorage } from './storage'
import StreamdelayClient from './StreamdelayClient'
import StreamWindow from './StreamWindow'
import TwitchBot from './TwitchBot'

const SENTRY_DSN =
  'https://e630a21dcf854d1a9eb2a7a8584cbd0b@o459879.ingest.sentry.io/5459505'

export interface StreamwallConfig {
  help: boolean
  grid: {
    count: number
  }
  window: {
    x?: number
    y?: number
    width: number
    height: number
    frameless: boolean
    'background-color': string
    'active-color': string
  }
  data: {
    interval: number
    'json-url': string[]
    'toml-file': string[]
  }
  streamdelay: {
    endpoint: string
    key: string | null
  }
  control: {
    endpoint: string
  }
  twitch: {
    channel: string | null
    username: string | null
    token: string | null
    color: string
    announce: {
      template: string
      interval: number
      delay: number
    }
    vote: {
      template: string
      interval: number
    }
  }
  telemetry: {
    sentry: boolean
  }
}

function parseArgs(): StreamwallConfig {
  // Load config from user data dir, if it exists
  const configPath = join(app.getPath('userData'), 'config.toml')
  console.debug('Reading config from ', configPath)

  let configText: string | null = null
  try {
    configText = fs.readFileSync(configPath, 'utf-8')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err
    }
  }

  return (
    yargs()
      .config(configText ? TOML.parse(configText) : {})
      .config('config', (configPath) => {
        return TOML.parse(fs.readFileSync(configPath, 'utf-8'))
      })
      .group(['grid.count'], 'Grid dimensions')
      .option('grid.count', {
        number: true,
        default: 3,
      })
      .group(
        [
          'window.width',
          'window.height',
          'window.x',
          'window.y',
          'window.frameless',
          'window.background-color',
          'window.active-color',
        ],
        'Window settings',
      )
      .option('window.x', {
        number: true,
      })
      .option('window.y', {
        number: true,
      })
      .option('window.width', {
        number: true,
        default: 1920,
      })
      .option('window.height', {
        number: true,
        default: 1080,
      })
      .option('window.frameless', {
        boolean: true,
        default: false,
      })
      .option('window.background-color', {
        describe: 'Background color of wall (useful for chroma-keying)',
        default: '#000',
      })
      .option('window.active-color', {
        describe: 'Active (highlight) color of wall',
        default: '#fff',
      })
      .group(
        ['data.interval', 'data.json-url', 'data.toml-file'],
        'Datasources',
      )
      .option('data.interval', {
        describe: 'Interval (in seconds) for refreshing polled data sources',
        number: true,
        default: 30,
      })
      .option('data.json-url', {
        describe: 'Fetch streams from the specified URL(s)',
        array: true,
        string: true,
        default: [],
      })
      .option('data.toml-file', {
        describe: 'Fetch streams from the specified file(s)',
        normalize: true,
        array: true,
        default: [],
      })
      .group(['streamdelay.endpoint', 'streamdelay.key'], 'Streamdelay')
      .option('streamdelay.endpoint', {
        describe: 'URL of Streamdelay endpoint',
        default: 'http://localhost:8404',
      })
      .option('streamdelay.key', {
        describe: 'Streamdelay API key',
        default: null,
      })
      .group(['control'], 'Remote Control')
      .option('control.endpoint', {
        describe: 'URL of control server endpoint',
        default: null,
      })
      .group(
        [
          'twitch.channel',
          'twitch.username',
          'twitch.token',
          'twitch.color',
          'twitch.announce.template',
          'twitch.announce.interval',
          'twitch.vote.template',
          'twitch.vote.interval',
        ],
        'Twitch Chat',
      )
      .option('twitch.channel', {
        describe: 'Name of Twitch channel',
        default: null,
      })
      .option('twitch.username', {
        describe: 'Username of Twitch bot account',
        default: null,
      })
      .option('twitch.token', {
        describe: 'Password of Twitch bot account',
        default: null,
      })
      .option('twitch.color', {
        describe: 'Color of Twitch bot username',
        default: '#ff0000',
      })
      .option('twitch.announce.template', {
        describe: 'Message template for stream announcements',
        default:
          'SingsMic <%- stream.source %> <%- stream.city && stream.state ? `(${stream.city} ${stream.state})` : `` %> <%- stream.link %>',
      })
      .option('twitch.announce.interval', {
        describe:
          'Minimum time interval (in seconds) between re-announcing the same stream',
        number: true,
        default: 60,
      })
      .option('twitch.announce.delay', {
        describe: 'Time to dwell on a stream before its details are announced',
        number: true,
        default: 30,
      })
      .option('twitch.vote.template', {
        describe: 'Message template for vote result announcements',
        default:
          'Switching to #<%- selectedIdx %> (with <%- voteCount %> votes)',
      })
      .option('twitch.vote.interval', {
        describe: 'Time interval (in seconds) between votes (0 to disable)',
        number: true,
        default: 0,
      })
      .group(['telemetry.sentry'], 'Telemetry')
      .option('telemetry.sentry', {
        describe: 'Enable error reporting to Sentry',
        boolean: true,
        default: true,
      })
      .help()
      // https://github.com/yargs/yargs/issues/2137
      .parseSync() as unknown as StreamwallConfig
  )
}

async function main(argv: ReturnType<typeof parseArgs>) {
  // Reject all permission requests from web content.
  session
    .fromPartition('persist:session')
    .setPermissionRequestHandler((webContents, permission, callback) => {
      callback(false)
    })

  const db = await loadStorage(
    join(app.getPath('userData'), 'streamwall-storage.json'),
  )

  console.debug('Creating StreamWindow...')
  const idGen = new StreamIDGenerator()

  const localStreamData = new LocalStreamData(db.data.localStreamData)
  localStreamData.on('update', (entries) => {
    db.update((data) => {
      data.localStreamData = entries
    })
  })

  const overlayStreamData = new LocalStreamData()

  const streamWindowConfig = {
    gridCount: argv.grid.count,
    width: argv.window.width,
    height: argv.window.height,
    x: argv.window.x,
    y: argv.window.y,
    frameless: argv.window.frameless,
    activeColor: argv.window['active-color'],
    backgroundColor: argv.window['background-color'],
  }
  const streamWindow = new StreamWindow(streamWindowConfig)
  const controlWindow = new ControlWindow()

  let browseWindow: BrowserWindow | null = null
  let streamdelayClient: StreamdelayClient | null = null

  console.debug('Creating initial state...')
  let clientState: StreamwallState = {
    identity: {
      role: 'local',
    },
    config: streamWindowConfig,
    streams: [],
    customStreams: [],
    views: [],
    streamdelay: null,
  }

  function updateViewsFromStateDoc() {
    try {
      const viewContentMap = new Map()
      for (const [key, viewData] of viewsState) {
        const streamId = viewData.get('streamId')
        const stream = clientState.streams.find((s) => s._id === streamId)
        if (!stream) {
          continue
        }
        viewContentMap.set(key, {
          url: stream.link,
          kind: stream.kind || 'video',
        })
      }
      streamWindow.setViews(viewContentMap, clientState.streams)
    } catch (err) {
      console.error('Error updating views', err)
    }
  }

  const stateDoc = new Y.Doc()
  const viewsState = stateDoc.getMap<Y.Map<string | undefined>>('views')

  if (db.data.stateDoc) {
    console.log('Loading stateDoc from storage...')
    try {
      Y.applyUpdate(stateDoc, Buffer.from(db.data.stateDoc, 'base64'))
    } catch (err) {
      console.warn('Failed to restore stateDoc', err)
    }
  }

  stateDoc.on(
    'update',
    throttle(() => {
      db.update((data) => {
        const fullDoc = Y.encodeStateAsUpdate(stateDoc)
        data.stateDoc = Buffer.from(fullDoc).toString('base64')
      })
    }, 1000),
  )

  stateDoc.transact(() => {
    for (let i = 0; i < argv.grid.count ** 2; i++) {
      if (viewsState.has(String(i))) {
        continue
      }
      const data = new Y.Map<string | undefined>()
      data.set('streamId', undefined)
      viewsState.set(String(i), data)
    }
  })

  updateViewsFromStateDoc()
  viewsState.observeDeep(updateViewsFromStateDoc)

  const onCommand = async (msg: ControlCommand) => {
    console.debug('Received message:', msg)
    if (msg.type === 'set-listening-view') {
      console.debug('Setting listening view:', msg.viewIdx)
      streamWindow.setListeningView(msg.viewIdx)
    } else if (msg.type === 'set-view-background-listening') {
      console.debug(
        'Setting view background listening:',
        msg.viewIdx,
        msg.listening,
      )
      streamWindow.setViewBackgroundListening(msg.viewIdx, msg.listening)
    } else if (msg.type === 'set-view-blurred') {
      console.debug('Setting view blurred:', msg.viewIdx, msg.blurred)
      streamWindow.setViewBlurred(msg.viewIdx, msg.blurred)
    } else if (msg.type === 'rotate-stream') {
      console.debug('Rotating stream:', msg.url, msg.rotation)
      overlayStreamData.update(msg.url, {
        rotation: msg.rotation,
      })
    } else if (msg.type === 'update-custom-stream') {
      console.debug('Updating custom stream:', msg.url)
      localStreamData.update(msg.url, msg.data)
    } else if (msg.type === 'delete-custom-stream') {
      console.debug('Deleting custom stream:', msg.url)
      localStreamData.delete(msg.url)
    } else if (msg.type === 'reload-view') {
      console.debug('Reloading view:', msg.viewIdx)
      streamWindow.reloadView(msg.viewIdx)
    } else if (msg.type === 'browse' || msg.type === 'dev-tools') {
      if (browseWindow && !browseWindow.isDestroyed()) {
        // DevTools needs a fresh webContents to work. Close any existing window.
        browseWindow.destroy()
        browseWindow = null
      }
      if (!browseWindow || browseWindow.isDestroyed()) {
        browseWindow = new BrowserWindow({
          webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            partition: 'persist:session',
            sandbox: true,
          },
        })
      }
      if (msg.type === 'browse') {
        console.debug('Attempting to browse URL:', msg.url)
        try {
          ensureValidURL(msg.url)
          browseWindow.loadURL(msg.url)
        } catch (error) {
          console.error('Invalid URL:', msg.url)
          console.error('Error:', error)
        }
      } else if (msg.type === 'dev-tools') {
        console.debug('Opening DevTools for view:', msg.viewIdx)
        streamWindow.openDevTools(msg.viewIdx, browseWindow.webContents)
      }
    } else if (msg.type === 'set-stream-censored' && streamdelayClient) {
      console.debug('Setting stream censored:', msg.isCensored)
      streamdelayClient.setCensored(msg.isCensored)
    } else if (msg.type === 'set-stream-running' && streamdelayClient) {
      console.debug('Setting stream running:', msg.isStreamRunning)
      streamdelayClient.setStreamRunning(msg.isStreamRunning)
    }
  }

  const stateEmitter = new EventEmitter<{ state: [StreamwallState] }>()

  function updateState(newState: Partial<StreamwallState>) {
    clientState = { ...clientState, ...newState }
    streamWindow.onState(clientState)
    controlWindow.onState(clientState)
    stateEmitter.emit('state', clientState)
  }

  // Wire up IPC:

  // StreamWindow view updates -> main
  streamWindow.on('state', (viewStates) => {
    updateState({ views: viewStates })
  })

  // StreamWindow <- main init state
  streamWindow.on('load', () => {
    streamWindow.onState(clientState)
  })

  // Control <- main collab updates
  stateDoc.on('update', (update) => {
    controlWindow.onYDocUpdate(update)
  })

  // Control <- main init state
  controlWindow.on('load', () => {
    controlWindow.onState(clientState)
    controlWindow.onYDocUpdate(Y.encodeStateAsUpdate(stateDoc))
  })

  // Control -> main
  controlWindow.on('ydoc', (update) => Y.applyUpdate(stateDoc, update))
  controlWindow.on('command', (command) => onCommand(command))

  // TODO: Hide on macOS, allow reopening from dock
  streamWindow.on('close', () => {
    process.exit(0)
  })

  if (argv.control.endpoint) {
    console.debug('Connecting to control server...')
    const ws = new ReconnectingWebSocket(argv.control.endpoint, [], {
      WebSocket,
      maxReconnectionDelay: 5000,
      minReconnectionDelay: 1000 + Math.random() * 500,
      reconnectionDelayGrowFactor: 1.1,
    })
    ws.binaryType = 'arraybuffer'
    ws.addEventListener('open', () => {
      console.debug('Control WebSocket connected.')
      ws.send(JSON.stringify({ type: 'state', state: clientState }))
      ws.send(Y.encodeStateAsUpdate(stateDoc))
    })
    ws.addEventListener('close', () => {
      console.debug('Control WebSocket disconnected.')
    })
    ws.addEventListener('message', (ev) => {
      if (ev.data instanceof ArrayBuffer) {
        Y.applyUpdate(stateDoc, new Uint8Array(ev.data))
      } else {
        let msg
        try {
          msg = JSON.parse(ev.data)
        } catch (err) {
          console.warn('Failed to parse control WebSocket message:', err)
        }

        onCommand(msg)
      }
    })
    stateEmitter.on('state', () => {
      ws.send(JSON.stringify({ type: 'state', state: clientState }))
    })
    stateDoc.on('update', (update) => {
      ws.send(update)
    })
  }

  if (argv.streamdelay.key) {
    console.debug('Setting up Streamdelay client...')
    streamdelayClient = new StreamdelayClient({
      endpoint: argv.streamdelay.endpoint,
      key: argv.streamdelay.key,
    })
    streamdelayClient.on('state', (state) => {
      updateState({ streamdelay: state })
    })
    streamdelayClient.connect()
  }

  const {
    username: twitchUsername,
    token: twitchToken,
    channel: twitchChannel,
  } = argv.twitch
  if (twitchUsername && twitchToken && twitchChannel) {
    console.debug('Setting up Twitch bot...')
    const twitchBot = new TwitchBot({
      ...argv.twitch,
      username: twitchUsername,
      token: twitchToken,
      channel: twitchChannel,
    })
    twitchBot.on('setListeningView', (idx) => {
      streamWindow.setListeningView(idx)
    })
    stateEmitter.on('state', () => twitchBot.onState(clientState))
    twitchBot.connect()
  }

  const dataSources = [
    ...argv.data['json-url'].map((url) => {
      console.debug('Setting data source from json-url:', url)
      return markDataSource(pollDataURL(url, argv.data.interval), 'json-url')
    }),
    ...argv.data['toml-file'].map((path) => {
      console.debug('Setting data source from toml-file:', path)
      return markDataSource(watchDataFile(path), 'toml-file')
    }),
    markDataSource(localStreamData.gen(), 'custom'),
    markDataSource(overlayStreamData.gen(), 'overlay'),
  ]

  for await (const streams of combineDataSources(dataSources, idGen)) {
    updateState({ streams })
    updateViewsFromStateDoc()
  }
}

function init() {
  console.debug('Parsing command line arguments...')
  const argv = parseArgs()
  if (argv.help) {
    return
  }

  console.debug('Initializing Sentry...')
  if (argv.telemetry.sentry) {
    Sentry.init({ dsn: SENTRY_DSN })
  }

  updateElectronApp()

  console.debug('Setting up Electron...')
  app.commandLine.appendSwitch('high-dpi-support', '1')
  app.commandLine.appendSwitch('force-device-scale-factor', '1')

  console.debug('Enabling Electron sandbox...')
  app.enableSandbox()

  app
    .whenReady()
    .then(() => main(argv))
    .catch((err) => {
      console.error(err)
      process.exit(1)
    })
}

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (started) {
  app.quit()
}

console.debug('Starting Streamwall...')
init()
