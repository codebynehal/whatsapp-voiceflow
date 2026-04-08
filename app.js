'use strict'
require('dotenv').config()

// 360Dialog API credentials
// Production base URL: https://waba-v2.360dialog.io
// Sandbox base URL:    https://waba-sandbox.360dialog.io/v1
const D360_API_KEY = process.env.D360_API_KEY
const D360_BASE_URL = process.env.D360_BASE_URL || 'https://waba-v2.360dialog.io'

const VF_API_KEY = process.env.VF_API_KEY
const VF_VERSION_ID = process.env.VF_VERSION_ID || 'development'
const VF_PROJECT_ID = process.env.VF_PROJECT_ID || null


// Validate user_id: allow only E.164-like phone numbers (optional +, 8-15 digits)
function isValidUserId(user_id) {
  return typeof user_id === 'string' && /^\+?[1-9]\d{7,14}$/.test(user_id)
}

let session = 0
let noreplyTimeout = null
let user_id = null
let user_name = null
// Deduplication: track recently processed message IDs to ignore duplicates
const processedMessages = new Set()
const MAX_PROCESSED = 1000
const VF_TRANSCRIPT_ICON =
  'https://s3.amazonaws.com/com.voiceflow.studio/share/200x200/200x200.png'

const VF_DM_URL =
  process.env.VF_DM_URL || 'https://general-runtime.voiceflow.com'

const DMconfig = {
  tts: false,
  stripSSML: true,
}

const express = require('express'),
  body_parser = require('body-parser'),
  axios = require('axios').default,
  app = express().use(body_parser.json())

app.listen(process.env.PORT || 3000, () => console.log('webhook is listening'))

app.get('/', (req, res) => {
  res.json({
    success: true,
    info: 'WhatsApp 360Dialog API | V⦿iceflow | 2024',
    status: 'healthy',
    error: null,
  })
})

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    provider: '360dialog',
    baseUrl: D360_BASE_URL,
    voiceflowUrl: VF_DM_URL,
  })
})

// Accepts POST requests at /webhook endpoint
// 360Dialog production (v2) uses the Meta Cloud API nested format:
//   entry[0].changes[0].value.messages
// 360Dialog sandbox (v1) uses a flat format:
//   messages at the top level
// This handler supports both.
app.post('/webhook', async (req, res) => {
  let body = req.body

  // Extract messages and contacts from either nested (v2) or flat (v1) format
  let messages, contacts
  if (body.entry?.[0]?.changes?.[0]?.value?.messages) {
    // Production v2 format (nested, same as Meta Cloud API)
    messages = body.entry[0].changes[0].value.messages
    contacts = body.entry[0].changes[0].value.contacts
  } else if (body.messages) {
    // Sandbox v1 format (flat)
    messages = body.messages
    contacts = body.contacts
  }

  if (messages && messages.length > 0) {
    let message = messages[0]

    // Deduplicate: skip if we already processed this message ID
    if (message.id && processedMessages.has(message.id)) {
      res.status(200).json({ message: 'ok' })
      return
    }
    if (message.id) {
      processedMessages.add(message.id)
      if (processedMessages.size > MAX_PROCESSED) {
        const first = processedMessages.values().next().value
        processedMessages.delete(first)
      }
    }

    user_id = message.from

    // Validate user_id before using it to prevent SSRF
    if (!isValidUserId(user_id)) {
      res.status(400).json({ message: 'Invalid user ID format.' })
      return
    }

    let user_name = contacts?.[0]?.profile?.name || 'Unknown'

    if (message.type === 'text') {
      await interact(
        user_id,
        {
          type: 'text',
          payload: message.text.body,
        },
        user_name
      )
    } else if (message.type === 'audio') {
      await sendMessage([{ type: 'text', value: "Sorry, I'm not able to process voice notes at the moment. Please send a text message instead." }], user_id)
    } else if (message.type === 'interactive') {
      const buttonReply = message.interactive?.button_reply
      if (buttonReply) {
        if (buttonReply.id.includes('path-')) {
          await interact(
            user_id,
            {
              type: buttonReply.id,
              payload: {
                label: buttonReply.title,
              },
            },
            user_name
          )
        } else {
          await interact(
            user_id,
            {
              type: 'intent',
              payload: {
                query: buttonReply.title,
                intent: {
                  name: buttonReply.id,
                },
                entities: [],
              },
            },
            user_name
          )
        }
      }
    }

    res.status(200).json({ message: 'ok' })
  } else if (body.statuses || body.entry?.[0]?.changes?.[0]?.value?.statuses) {
    // Status update events (sent, delivered, read) — acknowledge and ignore
    res.status(200).json({ message: 'ok' })
  } else if (body.entry || body.object) {
    // Other webhook events from 360Dialog/Meta (e.g. account updates) — acknowledge
    res.status(200).json({ message: 'ok' })
  } else {
    res.status(400).json({ message: 'error | unexpected body' })
  }
})

// Simple GET /webhook for health checks or manual verification.
// 360Dialog does NOT use the Meta hub.challenge verification flow.
// Set your webhook URL by calling:
//   POST ${D360_BASE_URL}/v1/configs/webhook
//   with header D360-API-KEY and body { "url": "https://your-server/webhook" }
app.get('/webhook', (req, res) => {
  const token = req.query['verify_token']
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN
  if (!VERIFY_TOKEN || token === VERIFY_TOKEN) {
    console.log('WEBHOOK_VERIFIED')
    res.status(200).send('ok')
  } else {
    res.sendStatus(403)
  }
})

async function interact(user_id, request, user_name) {
  clearTimeout(noreplyTimeout)
  if (!session) {
    session = `${VF_VERSION_ID}.${rndID()}`
  }

  await axios({
    method: 'PATCH',
    url: `${VF_DM_URL}/state/user/${encodeURI(user_id)}/variables`,
    headers: {
      Authorization: VF_API_KEY,
      'Content-Type': 'application/json',
    },
    data: {
      user_id: user_id,
      user_name: user_name,
    },
  })

  let response = await axios({
    method: 'POST',
    url: `${VF_DM_URL}/state/user/${encodeURI(user_id)}/interact`,
    headers: {
      Authorization: VF_API_KEY,
      'Content-Type': 'application/json',
      versionID: VF_VERSION_ID,
      sessionID: session,
    },
    data: {
      action: request,
      config: DMconfig,
    },
  })

  let isEnding = response.data.filter(({ type }) => type === 'end')
  if (isEnding.length > 0) {
    console.log('isEnding')
    isEnding = true
    saveTranscript(user_name)
  } else {
    isEnding = false
  }

  let messages = []

  for (let i = 0; i < response.data.length; i++) {
    if (response.data[i].type == 'text') {
      let tmpspeech = ''

      for (let j = 0; j < response.data[i].payload.slate.content.length; j++) {
        for (
          let k = 0;
          k < response.data[i].payload.slate.content[j].children.length;
          k++
        ) {
          if (response.data[i].payload.slate.content[j].children[k].type) {
            if (
              response.data[i].payload.slate.content[j].children[k].type ==
              'link'
            ) {
              tmpspeech +=
                response.data[i].payload.slate.content[j].children[k].url
            }
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != '' &&
            response.data[i].payload.slate.content[j].children[k].fontWeight
          ) {
            tmpspeech +=
              '*' +
              response.data[i].payload.slate.content[j].children[k].text +
              '*'
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != '' &&
            response.data[i].payload.slate.content[j].children[k].italic
          ) {
            tmpspeech +=
              '_' +
              response.data[i].payload.slate.content[j].children[k].text +
              '_'
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != '' &&
            response.data[i].payload.slate.content[j].children[k].underline
          ) {
            tmpspeech +=
              // no underline in WhatsApp
              response.data[i].payload.slate.content[j].children[k].text
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != '' &&
            response.data[i].payload.slate.content[j].children[k].strikeThrough
          ) {
            tmpspeech +=
              '~' +
              response.data[i].payload.slate.content[j].children[k].text +
              '~'
          } else if (
            response.data[i].payload.slate.content[j].children[k].text != ''
          ) {
            tmpspeech +=
              response.data[i].payload.slate.content[j].children[k].text
          }
        }
        tmpspeech += '\n'
      }
      if (
        response.data[i + 1]?.type &&
        response.data[i + 1]?.type == 'choice'
      ) {
        messages.push({
          type: 'body',
          value: tmpspeech,
        })
      } else {
        messages.push({
          type: 'text',
          value: tmpspeech,
        })
      }
    } else if (response.data[i].type == 'speak') {
      if (response.data[i].payload.type == 'audio') {
        messages.push({
          type: 'audio',
          value: response.data[i].payload.src,
        })
      } else {
        if (
          response.data[i + 1]?.type &&
          response.data[i + 1]?.type == 'choice'
        ) {
          messages.push({
            type: 'body',
            value: response.data[i].payload.message,
          })
        } else {
          messages.push({
            type: 'text',
            value: response.data[i].payload.message,
          })
        }
      }
    } else if (response.data[i].type == 'visual') {
      messages.push({
        type: 'image',
        value: response.data[i].payload.image,
      })
    } else if (response.data[i].type == 'choice') {
      let buttons = []
      for (let b = 0; b < response.data[i].payload.buttons.length; b++) {
        let link = null
        if (
          response.data[i].payload.buttons[b].request.payload.actions !=
            undefined &&
          response.data[i].payload.buttons[b].request.payload.actions.length > 0
        ) {
          link =
            response.data[i].payload.buttons[b].request.payload.actions[0]
              .payload.url
        }
        if (link) {
          // Ignore links
        } else if (
          response.data[i].payload.buttons[b].request.type.includes('path-')
        ) {
          buttons.push({
            type: 'reply',
            reply: {
              id: response.data[i].payload.buttons[b].request.type,
              title:
                truncateString(
                  response.data[i].payload.buttons[b].request.payload.label
                ) ?? '',
            },
          })
        } else {
          buttons.push({
            type: 'reply',
            reply: {
              id: response.data[i].payload.buttons[b].request.payload.intent
                .name,
              title:
                truncateString(
                  response.data[i].payload.buttons[b].request.payload.label
                ) ?? '',
            },
          })
        }
      }
      if (buttons.length > 3) {
        buttons = buttons.slice(0, 3)
      }
      messages.push({
        type: 'buttons',
        buttons: buttons,
      })
    } else if (response.data[i].type == 'no-reply' && isEnding == false) {
      noreplyTimeout = setTimeout(function () {
        sendNoReply(user_id, request, user_name)
      }, Number(response.data[i].payload.timeout) * 1000)
    }
  }
  await sendMessage(messages, user_id)
  if (isEnding == true) {
    session = null
  }
}

// Sends messages to the 360Dialog API.
// Unlike the Meta Cloud API, there is no phone_number_id in the path —
// authentication is via the D360-API-KEY header and the endpoint is fixed.
async function sendMessage(messages, to) {
  const timeoutPerKB = 10 // milliseconds per kilobyte, used to throttle after images
  for (let j = 0; j < messages.length; j++) {
    let data
    let ignore = null

    if (messages[j].type == 'image') {
      data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'image',
        image: {
          link: messages[j].value,
        },
      }
    } else if (messages[j].type == 'audio') {
      data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'audio',
        audio: {
          link: messages[j].value,
        },
      }
    } else if (messages[j].type == 'buttons') {
      data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'interactive',
        interactive: {
          type: 'button',
          body: {
            text: messages[j - 1]?.value || 'Make your choice',
          },
          action: {
            buttons: messages[j].buttons,
          },
        },
      }
    } else if (messages[j].type == 'text') {
      data = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: {
          preview_url: true,
          body: messages[j].value,
        },
      }
    } else {
      ignore = true
    }

    if (!ignore) {
      try {
        await axios({
          method: 'POST',
          url: `${D360_BASE_URL}/messages`,
          data: data,
          headers: {
            'Content-Type': 'application/json',
            'D360-API-KEY': D360_API_KEY,
          },
        })

        if (messages[j].type === 'image') {
          try {
            const response = await axios.head(messages[j].value)
            if (response.headers['content-length']) {
              const imageSizeKB =
                parseInt(response.headers['content-length']) / 1024
              const timeout = imageSizeKB * timeoutPerKB
              await new Promise((resolve) => setTimeout(resolve, timeout))
            }
          } catch (error) {
            console.error('Failed to fetch image size:', error)
            await new Promise((resolve) => setTimeout(resolve, 5000))
          }
        }
      } catch (err) {
        console.log(err)
      }
    }
  }
}

async function sendNoReply(user_id, request, user_name) {
  clearTimeout(noreplyTimeout)
  console.log('No reply')
  await interact(
    user_id,
    {
      type: 'no-reply',
    },
    user_name
  )
}

var rndID = function () {
  var randomNo = Math.floor(Math.random() * 1000 + 1)
  var timestamp = Date.now()
  var date = new Date()
  var weekday = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ]
  var day = weekday[date.getDay()]
  return randomNo + day + timestamp
}

function truncateString(str, maxLength = 20) {
  if (str) {
    if (str.length > maxLength) {
      return str.substring(0, maxLength - 1) + '…'
    }
    return str
  }
  return ''
}

async function saveTranscript(username) {
  if (VF_PROJECT_ID) {
    if (!username || username == '' || username == undefined) {
      username = 'Anonymous'
    }
    axios({
      method: 'put',
      url: 'https://api.voiceflow.com/v2/transcripts',
      data: {
        browser: 'WhatsApp',
        device: 'desktop',
        os: 'server',
        sessionID: session,
        unread: true,
        versionID: VF_VERSION_ID,
        projectID: VF_PROJECT_ID,
        user: {
          name: username,
          image: VF_TRANSCRIPT_ICON,
        },
      },
      headers: {
        Authorization: process.env.VF_API_KEY,
      },
    })
      .then(function (response) {
        console.log('Transcript Saved!')
      })
      .catch((err) => console.log(err))
  }
  session = `${VF_VERSION_ID}.${rndID()}`
}
