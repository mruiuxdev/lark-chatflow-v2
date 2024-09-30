const lark = require("@larksuiteoapi/node-sdk");
const dotenv = require("dotenv");
const express = require("express");
const fetch = require("node-fetch");

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

const LARK_APP_ID = process.env.LARK_APP_ID || "";
const LARK_APP_SECRET = process.env.LARK_APP_SECRET || "";
const FLOWISE_API_URL = process.env.FLOWISE_API_URL || "";
const UPLOAD_IMAGE_URL =
  "https://chatflow-aowb.onrender.com/api/v1/get-upload-file?chatflowId=dccc3181-d02f-4192-9a59-ddf342a31a28&chatId=12457e21-3585-4874-b042-60becefe54a4&fileName=artifact_1727207408905.png";

// Initialize the Lark client
const client = new lark.Client({
  appId: LARK_APP_ID,
  appSecret: LARK_APP_SECRET,
  disableTokenCache: false,
  domain: lark.Domain.Lark,
});

app.use(express.json());

function logger(...params) {
  console.error(`[CF]`, ...params);
}

async function cmdProcess({ action, sessionId, messageId }) {
  switch (action) {
    case "/help":
      return await cmdHelp(messageId);
    case "/clear":
      return await cmdClear(sessionId, messageId);
    default:
      return await cmdHelp(messageId);
  }
}

function formatMarkdown(text) {
  text = text.replace(/\*\*(.*?)\*\*/g, "<b>$1</b>");
  text = text.replace(/\*(.*?)\*/g, "<i>$1</i>");
  return text;
}

// Function to reply with image
async function replyWithImage(messageId, imageKey) {
  try {
    return await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({
          image_key: imageKey,
        }),
        msg_type: "image",
      },
    });
  } catch (e) {
    logger("Error sending image message to Lark", e, messageId);
  }
}

// Upload image and get image_key
async function uploadImage() {
  try {
    const response = await fetch(UPLOAD_IMAGE_URL);
    const data = await response.json();
    if (data.code === 0 && data.data.image_key) {
      logger("Image uploaded successfully, image_key:", data.data.image_key);
      return data.data.image_key;
    } else {
      throw new Error("Image upload failed");
    }
  } catch (error) {
    logger("Error uploading image:", error);
    throw error;
  }
}

async function reply(messageId, content, msgType = "text") {
  try {
    const formattedContent = formatMarkdown(content);
    return await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({
          text: formattedContent,
        }),
        msg_type: msgType,
      },
    });
  } catch (e) {
    const errorCode = e?.response?.data?.code;
    if (errorCode === 230002) {
      logger("Bot/User is not in the chat anymore", e, messageId, content);
    } else {
      logger("Error sending message to Lark", e, messageId, content);
    }
  }
}

async function cmdHelp(messageId) {
  const helpText = `
  Lark GPT Commands

  Usage:
  - /clear : Remove conversation history to start a new session.
  - /help : Get more help messages.
  `;
  await reply(messageId, helpText, "Help");
}

async function cmdClear(sessionId, messageId) {
  await reply(messageId, "✅ Conversation history cleared.");
}

async function queryFlowise(question, sessionId) {
  const data = {
    question: question,
    overrideConfig: {
      sessionId: sessionId,
    },
  };

  try {
    const response = await fetch(FLOWISE_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await response.json();

    if (result.text) {
      return result.text;
    }

    throw new Error("Invalid response from Flowise API");
  } catch (error) {
    logger("Error querying Flowise API:", error);
    throw error;
  }
}

async function handleReply(userInput, sessionId, messageId) {
  const question = userInput.text.replace("@_user_1", "").trim();
  logger("Received question:", question);

  if (question.startsWith("/")) {
    return await cmdProcess({ action: question, sessionId, messageId });
  }

  try {
    const answer = await queryFlowise(question, sessionId);
    return await reply(messageId, answer);
  } catch (error) {
    return await reply(
      messageId,
      "⚠️ An error occurred while processing your request."
    );
  }
}

async function validateAppConfig() {
  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    return { code: 1, message: "Missing Lark App ID or Secret" };
  }
  if (!LARK_APP_ID.startsWith("cli_")) {
    return { code: 1, message: "Lark App ID must start with 'cli_'" };
  }
  return { code: 0, message: "✅ Lark App configuration is valid." };
}

const processedEvents = new Set();

app.post("/webhook", async (req, res) => {
  const { body: params } = req;

  if (params.type === "url_verification") {
    return res.json({ challenge: params.challenge });
  }

  if (params.encrypt) {
    return res.json({
      code: 1,
      message: "Encryption is enabled, please disable it.",
    });
  }

  if (!params.header) {
    const configValidation = await validateAppConfig();
    return res.json(configValidation);
  }

  const { event_type: eventType, event_id: eventId } = params.header;

  if (eventType === "im.message.receive_v1") {
    const {
      message_id: messageId,
      chat_id: chatId,
      message_type: messageType,
    } = params.event.message;
    const senderId = params.event.sender.sender_id.user_id;

    const sessionId =
      params.event.overrideConfig?.sessionId || `${chatId}${senderId}`;

    if (processedEvents.has(eventId)) {
      return res.json({ code: 0, message: "Duplicate event" });
    }

    processedEvents.add(eventId);

    if (messageType !== "text") {
      await reply(messageId, "Only text messages are supported.");
      return res.json({ code: 0 });
    }

    const userInput = JSON.parse(params.event.message.content);

    // Upload image and get image_key
    const imageKey = await uploadImage();
    logger("Image Key and Message ID", { imageKey, messageId });

    // Reply with image and text
    await replyWithImage(messageId, imageKey);
    await handleReply(userInput, sessionId, messageId);

    return res.json({ code: 0 });
  }

  return res.json({ code: 2 });
});

app.get("/hello", (req, res) => {
  res.json({ message: "Hello, World!" });
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
