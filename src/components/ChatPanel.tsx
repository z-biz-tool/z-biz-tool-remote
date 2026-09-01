import { Card, Input, List, Space, Typography } from "antd";
import { SendOutlined } from "@ant-design/icons";
import { useState } from "react";
import { useSessionStore } from "../stores/sessionStore";
import { signaling } from "../services/signaling";
import { t } from "../i18n";
import type { SignalMessage } from "../types";

interface ChatMessage {
  id: string;
  text: string;
  fromId: string;
  fromName?: string;
  timestamp: number;
  isMe: boolean;
}

const { TextArea } = Input;

export function ChatPanel() {
  const { sessionId, targetDeviceId, deviceId } = useSessionStore();
  const [messageText, setMessageText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  // 监听聊天消息
  useState(() => {
    const off = signaling.on("chat-message", ({ message, fromId, timestamp }) => {
      const isMe = fromId === deviceId;
      const msg: ChatMessage = {
        id: Math.random().toString(36).substring(2, 15),
        text: message,
        fromId,
        timestamp,
        isMe,
      };
      setMessages((prev) => [...prev, msg]);
    });

    return () => off();
  }, []);

  const sendMessage = () => {
    if (!messageText.trim() || !sessionId) return;

    const msg: ChatMessage = {
      id: Math.random().toString(36).substring(2, 15),
      text: messageText,
      fromId: deviceId ?? "",
      timestamp: Date.now(),
      isMe: true,
    };
    setMessages((prev) => [...prev, msg]);
    signaling.sendChatMessage(sessionId, messageText.trim());
    setMessageText("");
  };

  const formatTime = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
  };

  return (
    <Card
      title={
        <Space>
          <SendOutlined />
          <span>聊天</span>
        </Space>
      }
      size="small"
    >
      <div
        style={{
          maxHeight: 250,
          overflowY: "auto",
          marginBottom: 12,
          backgroundColor: "#fafafa",
          borderRadius: 4,
          padding: 8,
        }}
      >
        {messages.length === 0 ? (
          <div style={{ textAlign: "center", color: "#999", padding: 20 }}>
            {t("chat.empty")}
          </div>
        ) : (
          <List
            dataSource={messages}
            renderItem={(msg) => (
              <List.Item
                style={{
                  justifyContent: msg.isMe ? "flex-end" : "flex-start",
                  backgroundColor: msg.isMe ? "#e6f7ff" : "#fffbe6",
                  borderRadius: 4,
                  padding: "8px 12px",
                  marginBottom: 8,
                  maxWidth: "80%",
                }}
              >
                <div>
                  <div
                    style={{
                      color: "#666",
                      fontSize: 12,
                      marginBottom: 4,
                    }}
                  >
                    {msg.isMe ? t("chat.me") : t("chat.remote")} - {formatTime(msg.timestamp)}
                  </div>
                  <div style={{ color: "#333', fontSize: 14 }}>{msg.text}</div>
                </div>
              </List.Item>
            )}
          />
        )}
      </div>

      <Space.Compact style={{ width: "100%" }}>
        <TextArea
          value={messageText}
          onChange={(e) => setMessageText(e.target.value)}
          placeholder={t("chat.placeholder")}
          rows={2}
          onPressEnter={(e) => {
            if (e.shiftKey) return;
            e.preventDefault();
            sendMessage();
          }}
        />
        <Button
          type="primary"
          icon={<SendOutlined />}
          onClick={sendMessage}
          disabled={!messageText.trim() || !sessionId}
        />
      </Space.Compact>
    </Card>
  );
}
