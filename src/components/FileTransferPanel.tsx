import { Button, Card, List, Progress, Space, message } from "antd";
import { UploadOutlined, DownloadOutlined, CloseOutlined } from "@ant-design/icons";
import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSessionStore } from "../stores/sessionStore";
import { signaling } from "../services/signaling";
import { t } from "../i18n";
import type { FileTransferRequest, FileTransferState } from "../types";

// 文件传输请求队列
const fileTransferRequests: Map<string, FileTransferRequest> = new Map();
// 正在传输的文件状态
const fileTransferStates: Map<string, FileTransferState> = new Map();

export function FileTransferPanel() {
  const { sessionId, targetDeviceId, role } = useSessionStore();
  const [receivedRequests, setReceivedRequests] = useState<FileTransferRequest[]>([]);
  const [transferStates, setTransferStates] = useState<FileTransferState[]>([]);

  // 监听文件传输请求
  useEffect(() => {
    const off = signaling.on("file-transfer-request", ({ requestId, fileName, fileSize, fromId }) => {
      const request: FileTransferRequest = { requestId, fileName, fileSize, fromId, timestamp: Date.now() };
      fileTransferRequests.set(requestId, request);
      setReceivedRequests((prev) => [...prev, request]);
      message.info(`收到文件传输请求: ${fileName} (${(fileSize / 1024).toFixed(2)} KB)`);
    });

    const offProgress = signaling.on("file-transfer-progress", ({ requestId, progress }) => {
      const state = fileTransferStates.get(requestId);
      if (state) {
        state.progress = progress;
        setTransferStates((prev) => [...prev.filter((s) => s.requestId !== requestId), state]);
      }
    });

    const offComplete = signaling.on("file-transfer-complete", ({ requestId, fileName }) => {
      const state = fileTransferStates.get(requestId);
      if (state) {
        state.status = "completed";
        message.success(`文件传输完成: ${fileName}`);
      }
    });

    return () => {
      off();
      offProgress();
      offComplete();
    };
  }, [sessionId, targetDeviceId]);

  // 保存文件
  const saveFile = async (requestId: string, fileName: string, data: string) => {
    try {
      // 将 base64 转换为 Blob
      const base64Data = data.replace(/^data:.*;base64,/, "");
      const byteCharacters = atob(base64Data);
      const byteArrays = [];
      for (let offset = 0; offset < byteCharacters.length; offset += 512) {
        const slice = byteCharacters.slice(offset, offset + 512);
        const byteNumbers = new Array(slice.length);
        for (let i = 0; i < slice.length; i++) {
          byteNumbers[i] = slice.charCodeAt(i);
        }
        const byteArray = new Uint8Array(byteNumbers);
        byteArrays.push(byteArray);
      }
      const blob = new Blob(byteArrays, { type: "application/octet-stream" });

      // 使用 Tauri 的 FS 插件保存文件
      const { writeBinaryFile } = await import("@tauri-apps/plugin-fs");
      const dir = await invoke<string>("get_downloads_directory");
      const filePath = `${dir}/${fileName}`;
      await writeBinaryFile(filePath, new Uint8Array(await blob.arrayBuffer()));
      message.success(`文件已保存到: ${filePath}`);
      return true;
    } catch (e) {
      console.error("保存文件失败:", e);
      message.error("保存文件失败: " + String(e));
      return false;
    }
  };

  const acceptRequest = async (requestId: string) => {
    const request = fileTransferRequests.get(requestId);
    if (!request || !sessionId) return;

    signaling.acceptFileTransfer(sessionId, requestId);

    // 准备保存
    const state: FileTransferState = {
      requestId,
      fileName: request.fileName,
      fileSize: request.fileSize,
      received: 0,
      progress: 0,
      status: "accepting",
    };
    fileTransferStates.set(requestId, state);
    setTransferStates((prev) => [...prev, state]);

    message.info(`正在接受文件: ${request.fileName}...`);
  };

  const rejectRequest = (requestId: string) => {
    const request = fileTransferRequests.get(requestId);
    if (!request || !sessionId) return;

    signaling.rejectFileTransfer(sessionId, requestId, "用户拒绝");
    fileTransferRequests.delete(requestId);
    setReceivedRequests((prev) => prev.filter((r) => r.requestId !== requestId));
    message.info(`已拒绝文件传输: ${request.fileName}`);
  };

  const sendFile = async () => {
    if (!sessionId || !targetDeviceId) {
      message.warning("请先加入会话");
      return;
    }

    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = async () => {
        const data = reader.result as string;
        const requestId = Math.random().toString(36).substring(2, 15);
        const totalSize = file.size;

        // 发送请求
        signaling.sendFileTransferRequest(sessionId, file.name, totalSize, requestId);

        // 分块发送数据
        const chunkSize = 64 * 1024; // 64KB
        let sent = 0;
        const state: FileTransferState = {
          requestId,
          fileName: file.name,
          fileSize: totalSize,
          received: 0,
          progress: 0,
          status: "transferring",
        };
        fileTransferStates.set(requestId, state);
        setTransferStates((prev) => [...prev, state]);

        for (let i = 0; i < totalSize; i += chunkSize) {
          const chunk = data.substring(i, Math.min(i + chunkSize, totalSize));
          const isEnd = i + chunkSize >= totalSize;
          signaling.sendFileData(sessionId, requestId, chunk, isEnd);

          sent += chunk.length;
          const progress = Math.round((sent / totalSize) * 100);

          // 更新进度
          if (state) {
            state.progress = progress;
            setTransferStates((prev) => [...prev.filter((s) => s.requestId !== requestId), state]);
          }
          signaling.sendFileTransferProgress(sessionId, requestId, progress);
        }

        message.success(`文件发送完成: ${file.name}`);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  return (
    <Card
      title={
        <Space>
          <UploadOutlined />
          <span>文件传输</span>
        </Space>
      }
      size="small"
      extra={
        role === "client" ? (
          <Button icon={<UploadOutlined />} size="small" onClick={sendFile}>
            发送文件
          </Button>
        ) : null
      }
    >
      <div style={{ maxHeight: 200, overflowY: "auto" }}>
        {receivedRequests.length > 0 && (
          <>
            <div style={{ fontWeight: "bold", marginBottom: 8 }}>待接受的文件:</div>
            <List
              dataSource={receivedRequests}
              renderItem={(req) => (
                <List.Item
                  actions={[
                    <Button
                      key="accept"
                      size="small"
                      type="primary"
                      onClick={() => acceptRequest(req.requestId)}
                    >
                      接受
                    </Button>,
                    <Button
                      key="reject"
                      size="small"
                      danger
                      onClick={() => rejectRequest(req.requestId)}
                    >
                      拒绝
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={req.fileName}
                    description={`${(req.fileSize / 1024).toFixed(2)} KB | 来自: ${req.fromId?.substring(0, 8)}...`}
                  />
                </List.Item>
              )}
            />
          </>
        )}

        {transferStates.length > 0 && (
          <>
            <div style={{ fontWeight: "bold", marginBottom: 8 }}>传输进度:</div>
            <List
              dataSource={transferStates}
              renderItem={(state) => (
                <List.Item>
                  <List.Item.Meta
                    title={
                      <Space>
                        <span>{state.fileName}</span>
                        <span style={{ color: state.status === "completed" ? "green" : "blue" }}>
                          {state.status === "completed" ? "已完成" : `${state.progress}%`}
                        </span>
                      </Space>
                    }
                    description={
                      <Progress
                        percent={state.progress}
                        status={state.status === "failed" ? "exception" : "active"}
                        strokeColor={{
                          "0%": "#108ee9",
                          "100%": "#87d068",
                        }}
                      />
                    }
                  />
                  {state.status === "completed" && (
                    <Button
                      icon={<CloseOutlined />}
                      size="small"
                      onClick={() =>
                        setTransferStates((prev) => prev.filter((s) => s.requestId !== state.requestId))
                      }
                    />
                  )}
                </List.Item>
              )}
            />
          </>
        )}
      </div>
    </Card>
  );
}

// 扩展 signaling 以支持进度通知
if (!("sendFileTransferProgress" in signaling)) {
  (signaling as any).sendFileTransferProgress = function (
    sessionId: string,
    requestId: string,
    progress: number
  ) {
    this.send({ type: "FILE_TRANSFER_PROGRESS", sessionId, requestId, progress, fromId: this.deviceId ?? "" });
  };
}
