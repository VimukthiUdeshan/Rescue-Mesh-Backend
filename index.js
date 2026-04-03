require("dotenv").config();
const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const axios = require("axios");
const summarizeMessage = require("./gem");

const app = express();
app.use(cors());
app.use(express.json());

const serviceAccount = require("./serviceAccountKey.json");

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();
const { Timestamp } = admin.firestore;

/* ================= HELPERS ================= */

function makeMessageId(node_key, seq) {
  const safeSeq = String(seq).trim().padStart(2, "0");
  return `${node_key}_${safeSeq}_${Date.now()}`;
}

async function isRecentDuplicate(node_key, seq, flag, message) {
  const snapshot = await db
    .collection("C1")
    .where("node_key", "==", node_key)
    .where("seq", "==", seq)
    .where("flag", "==", flag)
    .where("message", "==", message)
    .get();

  const now = Date.now();

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const ts = data.timestamp?.toDate?.()?.getTime?.() || 0;
    if (now - ts < 60000) {
      return true;
    }
  }

  return false;
}

function sanitizeReplyText(text) {
  return String(text || "")
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 200);
}

function cleanIncomingText(text) {
  const original = String(text || "").trim();
  const cleaned = original.replace(/[^a-zA-Z\u0D80-\u0DFF\s]/g, "").trim();
  return cleaned || original;
}

async function getGeminiReplySuggestion(sos) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in environment variables");
  }

  const prompt = `
You are an emergency reply assistant for a flood rescue center.

Generate exactly one short reply suggestion for the affected user.

Rules:
- Keep it calm, clear, and practical.
- Maximum 160 characters.
- Do not promise exact rescue arrival times.
- Do not invent facts.
- Do not mention anything about AI.
- If severity is critical, prioritize immediate safety.
- If the message is unclear, acknowledge receipt and advise staying safe.
- Return only a JSON object.

Incident details:
Node key: ${sos.node_key || ""}
Message ID: ${sos.messageId || ""}
Message: ${sos.message || ""}
Summary: ${sos.summary || ""}
Severity: ${sos.severity || "Unknown"}
Family members: ${sos.familyMembers ?? "Unknown"}
Location: ${sos.latitude ?? "-"}, ${sos.longitude ?? "-"}
`;

  const response = await axios.post(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    {
      contents: [
        {
          parts: [{ text: prompt }]
        }
      ],
      generationConfig: {
        temperature: 0.4,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            suggestedReply: { type: "string" }
          },
          required: ["suggestedReply"]
        }
      }
    },
    {
      headers: {
        "x-goog-api-key": apiKey,
        "Content-Type": "application/json"
      }
    }
  );

  const rawText =
    response.data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    parsed = {
      suggestedReply: "SOS received. Stay safe and move to higher ground if possible."
    };
  }

  return sanitizeReplyText(parsed.suggestedReply);
}

/* ================= CORE ALERT HANDLER ================= */

async function handleIncomingSos(req, res) {
  try {
    let { node_key, seq, flag, decrypted, message, timestamp, gateway_id } = req.body;

    const incomingMessage = String(decrypted ?? message ?? "").trim();

    if (node_key == null || seq == null || flag == null || !incomingMessage) {
      return res.status(400).json({
        success: false,
        message: "Missing required fields"
      });
    }

    node_key = String(node_key).trim();
    seq = String(seq).trim();
    flag = String(flag).trim();

    const messageId = makeMessageId(node_key, seq);

    const deviceRef = db.collection("registered_devices").doc(node_key);
    const deviceSnap = await deviceRef.get();

    if (!deviceSnap.exists) {
      return res.status(403).json({
        success: false,
        message: "Unauthorized device key"
      });
    }

    const deviceData = deviceSnap.data();

    if (!deviceData?.isActive) {
      return res.status(403).json({
        success: false,
        message: "Device is inactive"
      });
    }

    const duplicate = await isRecentDuplicate(node_key, seq, flag, incomingMessage);
    if (duplicate) {
      return res.status(200).json({
        success: true,
        duplicate: true,
        message: "Duplicate message ignored",
        messageId
      });
    }

    const data = {
      messageId,
      node_key,
      seq,
      flag,
      rawMessage: null,
      message: incomingMessage,
      gateway_id: gateway_id || "UNKNOWN_GATEWAY",
      gateway_timestamp: timestamp ?? null,

      ownerName: deviceData.ownerName || "",
      mobileNumber: deviceData.mobileNumber || "",
      familyMembers: Number(deviceData.familyMembers || 0),
      latitude: Number(deviceData.homeLatitude ?? 0),
      longitude: Number(deviceData.homeLongitude ?? 0),

      status: "Active",
      handled: false,
      actionTaken: "Not Assigned",
      timestamp: Timestamp.now()
    };

    if (flag === "BTN_CRITICAL") {
      data.severity = "Critical";
      data.summary = "Critical emergency SOS alert received";
    } else if (flag === "BTN_GENERAL") {
      data.severity = "Moderate";
      data.summary = "General safety issue reported";
    } else {
      const cleanMessage = cleanIncomingText(incomingMessage);

      try {
        const aiResponse = await axios.post(
          "http://127.0.0.1:5000/predict",
          { message: cleanMessage }
        );

        data.severity = aiResponse.data?.severity || "Unknown";

        if (cleanMessage.length > 40) {
          try {
            data.summary = await summarizeMessage(cleanMessage);
          } catch (err) {
            console.error("Summary AI Error:", err.message);
            data.summary = cleanMessage;
          }
        } else {
          data.summary = cleanMessage;
        }
      } catch (err) {
        console.error("AI Prediction Error:", err.message);
        data.severity = "Unknown";
        data.summary = cleanMessage;
      }
    }

    await db.collection("C1").add(data);

    return res.status(200).json({
      success: true,
      duplicate: false,
      message: "SOS received successfully",
      severity: data.severity,
      messageId
    });
  } catch (err) {
    console.error("SOS route error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error"
    });
  }
}

/* ================= ROUTES ================= */

app.get("/", (req, res) => {
  res.send("✅ SOS API is running");
});

/* Support both route names */
app.post("/api/sos", handleIncomingSos);
app.post("/api/alerts", handleIncomingSos);

/* ================= AI REPLY SUGGESTION ================= */

app.post("/api/reply-suggestion", async (req, res) => {
  try {
    const { messageId } = req.body;

    if (messageId == null || String(messageId).trim() === "") {
      return res.status(400).json({
        success: false,
        message: "messageId is required",
      });
    }

    const sosSnapshot = await db
      .collection("C1")
      .where("messageId", "==", String(messageId).trim())
      .limit(1)
      .get();

    if (sosSnapshot.empty) {
      return res.status(404).json({
        success: false,
        message: "SOS record not found",
      });
    }

    const sosDoc = sosSnapshot.docs[0];
    const sosData = sosDoc.data();

    const suggestedReply = await getGeminiReplySuggestion(sosData);

    return res.status(200).json({
      success: true,
      messageId: sosData.messageId,
      suggestedReply
    });
  } catch (err) {
    console.error("Reply suggestion error:", err?.response?.data || err.message);
    return res.status(500).json({
      success: false,
      message: "Failed to generate AI reply suggestion",
    });
  }
});

/* ================= DASHBOARD SEND REPLY ================= */

app.post("/api/reply", async (req, res) => {
  try {
    let { messageId, replyText, sentBy, gateway_id } = req.body;

    if (messageId == null || replyText == null) {
      return res.status(400).json({
        success: false,
        message: "messageId and replyText are required",
      });
    }

    messageId = String(messageId).trim();
    sentBy = String(sentBy || "Dashboard Operator").trim();
    gateway_id = String(gateway_id || "GATEWAY_01").trim();

    if (!messageId) {
      return res.status(400).json({
        success: false,
        message: "messageId cannot be empty",
      });
    }

    const cleanReply = sanitizeReplyText(replyText);

    if (!cleanReply) {
      return res.status(400).json({
        success: false,
        message: "Reply text is empty after sanitization",
      });
    }

    const sosSnapshot = await db
      .collection("C1")
      .where("messageId", "==", messageId)
      .limit(1)
      .get();

    if (sosSnapshot.empty) {
      return res.status(404).json({
        success: false,
        message: "Original SOS message not found",
      });
    }

    const sosDoc = sosSnapshot.docs[0];
    const sosData = sosDoc.data();

    const replyRecord = {
      sosDocId: sosDoc.id,
      messageId,
      targetNodeKey: sosData.node_key,
      seq: sosData.seq,
      replyText: cleanReply,
      sentBy,
      gateway_id,
      status: "Pending",
      delivered: false,
      sentAt: null,
      timestamp: Timestamp.now(),
    };

    const replyRef = await db.collection("responses").add(replyRecord);

    const gatewayCommand = `FGR|${sosData.node_key}|${messageId}|${cleanReply}`;

    await db.collection("gateway_outbox").add({
      sosDocId: sosDoc.id,
      messageId,
      targetNodeKey: sosData.node_key,
      gateway_id,
      replyText: cleanReply,
      command: gatewayCommand,
      status: "Pending",
      delivered: false,
      createdAt: Timestamp.now(),
      sentAt: null,
      responseRefId: replyRef.id,
    });

    await sosDoc.ref.update({
      handled: true,
      actionTaken: "Reply queued",
    });

    return res.status(200).json({
      success: true,
      message: "Reply queued successfully",
      gatewayCommand,
      replyId: replyRef.id,
    });
  } catch (err) {
    console.error("Reply route error:", err);
    return res.status(500).json({
      success: false,
      message: "Server error while creating reply",
    });
  }
});

/* ================= GATEWAY FETCH PENDING REPLIES ================= */

app.get("/api/replies/pending", async (req, res) => {
  try {
    const gatewayId = String(req.query.gateway_id || "GATEWAY_01").trim();

    const snapshot = await db
      .collection("gateway_outbox")
      .where("status", "==", "Pending")
      .where("gateway_id", "==", gatewayId)
      .limit(10)
      .get();

    let replies = snapshot.docs.map((doc) => {
      const data = doc.data();

      return {
        reply_id: doc.id,
        node_key: data.targetNodeKey || "",
        message_id: data.messageId || "",
        reply_message: data.replyText || "",
        gateway_id: data.gateway_id || gatewayId,
        created_at_ms: data.createdAt?.toMillis?.() || 0
      };
    });

    replies.sort((a, b) => a.created_at_ms - b.created_at_ms);

    replies = replies.map(({ created_at_ms, ...rest }) => rest);

    return res.status(200).json({
      success: true,
      count: replies.length,
      replies
    });
  } catch (err) {
    console.error("Pending replies fetch error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch pending replies",
      error: err.message
    });
  }
});

/* ================= GATEWAY MARK REPLY AS SENT ================= */

app.post("/api/replies/mark-sent", async (req, res) => {
  try {
    let { reply_id, gateway_id } = req.body;

    reply_id = String(reply_id || "").trim();
    gateway_id = String(gateway_id || "GATEWAY_01").trim();

    if (!reply_id) {
      return res.status(400).json({
        success: false,
        message: "reply_id is required"
      });
    }

    const outboxRef = db.collection("gateway_outbox").doc(reply_id);
    const outboxSnap = await outboxRef.get();

    if (!outboxSnap.exists) {
      return res.status(404).json({
        success: false,
        message: "Reply record not found"
      });
    }

    const outboxData = outboxSnap.data();

    await outboxRef.update({
      status: "Sent",
      delivered: true,
      sentAt: Timestamp.now(),
      sentByGateway: gateway_id
    });

    if (outboxData?.responseRefId) {
      await db.collection("responses").doc(outboxData.responseRefId).update({
        status: "Sent",
        delivered: true,
        sentAt: Timestamp.now(),
        sentByGateway: gateway_id
      });
    }

    if (outboxData?.sosDocId) {
      await db.collection("C1").doc(outboxData.sosDocId).update({
        handled: true,
        actionTaken: "Reply sent to mesh"
      });
    }

    return res.status(200).json({
      success: true,
      message: "Reply marked as sent",
      reply_id
    });
  } catch (err) {
    console.error("Mark sent error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to mark reply as sent",
      error: err.message
    });
  }
});

/* ================= OPTIONAL: VIEW REPLY HISTORY ================= */

app.get("/api/replies/history", async (req, res) => {
  try {
    const snapshot = await db
      .collection("responses")
      .orderBy("timestamp", "desc")
      .limit(50)
      .get();

    const replies = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data()
    }));

    return res.status(200).json({
      success: true,
      replies
    });
  } catch (err) {
    console.error("Reply history error:", err);
    return res.status(500).json({
      success: false,
      message: "Failed to fetch reply history",
      error: err.message
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on ${PORT}`));