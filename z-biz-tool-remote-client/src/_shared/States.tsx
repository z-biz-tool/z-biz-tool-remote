import { Spin, Result, Button } from "antd";
import {
  InboxOutlined,
  ReloadOutlined,
  LoadingOutlined,
} from "@ant-design/icons";
import type { ReactNode } from "react";

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({
  title = "暂无数据",
  description = "请先添加内容后查看",
  icon,
  action,
}: EmptyStateProps) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 240,
        gap: 12,
        padding: "0 16px",
        textAlign: "center",
      }}
    >
      {icon ?? (
        <InboxOutlined
          aria-hidden="true"
          style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }}
        />
      )}
      <div style={{ fontWeight: 500, fontSize: 15 }}>{title}</div>
      {description && (
        <div style={{ color: "var(--ant-color-text-tertiary)", fontSize: 13, maxWidth: 360 }}>
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

interface LoadingStateProps {
  tip?: string;
  minHeight?: number;
}

export function LoadingState({ tip = "加载中...", minHeight = 240 }: LoadingStateProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100%",
        minHeight,
      }}
    >
      <Spin
        tip={tip}
        size="large"
        indicator={<LoadingOutlined style={{ fontSize: 28 }} spin />}
      />
    </div>
  );
}

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
}

export function ErrorState({ message = "发生未知错误", onRetry }: ErrorStateProps) {
  return (
    <Result
      status="error"
      title="操作失败"
      subTitle={message}
      extra={
        onRetry ? (
          <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
            重试
          </Button>
        ) : undefined
      }
    />
  );
}