import { useState, type ReactNode } from "react";
import { theme } from "antd";
import { DownOutlined } from "@ant-design/icons";

interface CollapsiblePanelProps {
  /** 面板标题 */
  title: ReactNode;
  /** 标题旁的徽标（如 Badge） */
  badge?: ReactNode;
  /** 内容 */
  children: ReactNode;
  /** 默认是否展开 */
  defaultExpanded?: boolean;
  /** 受控展开状态 */
  expanded?: boolean;
  /** 状态变化回调 */
  onExpandedChange?: (expanded: boolean) => void;
  /** 标题右侧额外操作 */
  extra?: ReactNode;
}

/**
 * 可折叠面板 - 用于侧栏分组（搜索/收藏/暂存栈/文件树等）
 * - 标题点击可折叠/展开
 * - 折叠时内容区域有平滑过渡
 * - 支持键盘可达（Enter/Space）
 */
export function CollapsiblePanel({
  title,
  badge,
  children,
  defaultExpanded = true,
  expanded: controlledExpanded,
  onExpandedChange,
  extra,
}: CollapsiblePanelProps) {
  const [internalExpanded, setInternalExpanded] = useState(defaultExpanded);
  const { token } = theme.useToken();
  const isControlled = controlledExpanded !== undefined;
  const expanded = isControlled ? controlledExpanded : internalExpanded;

  const toggle = () => {
    const next = !expanded;
    if (!isControlled) setInternalExpanded(next);
    onExpandedChange?.(next);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  };

  return (
    <div style={{ borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggle}
        onKeyDown={onKey}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          padding: "8px 12px",
          fontWeight: 600,
          fontSize: 13,
          color: token.colorText,
          cursor: "pointer",
          userSelect: "none",
          background: token.colorBgContainer,
          transition: "background 0.15s",
        }}
        onMouseEnter={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = token.colorBgTextHover;
        }}
        onMouseLeave={(e) => {
          (e.currentTarget as HTMLDivElement).style.background = token.colorBgContainer;
        }}
      >
        <span aria-hidden style={{ display: "inline-flex", transition: "transform 0.2s", transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}>
          <DownOutlined style={{ fontSize: 11 }} />
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>{title}</span>
        {badge}
        {extra && <span onClick={(e) => e.stopPropagation()}>{extra}</span>}
      </div>
      <div
        style={{
          overflow: "hidden",
          maxHeight: expanded ? 2000 : 0,
          transition: "max-height 0.25s cubic-bezier(0.4, 0, 0.2, 1)",
        }}
        aria-hidden={!expanded}
      >
        <div style={{ padding: "4px 0" }}>{children}</div>
      </div>
    </div>
  );
}