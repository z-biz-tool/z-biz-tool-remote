import { useEffect, type ReactNode } from "react";
import { Layout, Button, Space, Typography, theme, Tooltip } from "antd";
import {
  BulbOutlined,
  BulbFilled,
  MenuUnfoldOutlined,
  MenuFoldOutlined,
} from "@ant-design/icons";
import { useTheme } from "./ThemeContext";

const { Header, Sider, Content } = Layout;

interface AppShellProps {
  title: string;
  icon?: ReactNode;
  sidebar: ReactNode;
  headerExtra?: ReactNode;
  children: ReactNode;
  siderWidth?: number;
  collapsedSider?: boolean;
  onToggleSider?: () => void;
}

export function AppShell({
  title,
  icon,
  sidebar,
  headerExtra,
  children,
  siderWidth = 220,
  collapsedSider = false,
  onToggleSider,
}: AppShellProps) {
  const { mode, toggle } = useTheme();
  const { token } = theme.useToken();

  // 监听系统主题变化（仅在用户未手动覆盖时，这里仅作为提示）
  useEffect(() => {
    // 占位：未来若要支持“跟随系统”可在此实现
  }, [mode]);

  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform);
  const modKey = isMac ? "⌘" : "Ctrl";

  return (
    <Layout style={{ height: "100vh" }}>
      <Header
        role="banner"
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 12px 0 8px",
          height: 44,
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Space size={6} align="center">
          {onToggleSider && (
            <Tooltip title={`${modKey}+B 折叠侧栏`} placement="bottom">
              <Button
                type="text"
                size="small"
                icon={collapsedSider ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
                onClick={onToggleSider}
                aria-label={collapsedSider ? "展开侧栏" : "折叠侧栏"}
              />
            </Tooltip>
          )}
          {icon}
          <Typography.Text strong style={{ fontSize: 14 }}>
            {title}
          </Typography.Text>
        </Space>
        <Space size={2}>
          {headerExtra}
          <Tooltip title={`${modKey}+Shift+L 切换主题`} placement="bottom">
            <Button
              type="text"
              size="small"
              icon={mode === "dark" ? <BulbFilled /> : <BulbOutlined />}
              onClick={toggle}
              aria-label={mode === "dark" ? "切换到亮色" : "切换到暗色"}
              title={mode === "dark" ? "切换到亮色" : "切换到暗色"}
            />
          </Tooltip>
        </Space>
      </Header>
      <Layout>
        <Sider
          width={siderWidth}
          collapsedWidth={0}
          collapsed={collapsedSider}
          trigger={null}
          collapsible={false}
          role="navigation"
          aria-label="侧栏导航"
          style={{
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            overflow: "hidden",
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
            flexShrink: 0,
          }}
        >
          <div style={{ width: siderWidth, height: "100%", overflow: "auto" }}>
            {sidebar}
          </div>
        </Sider>
        <Content
          role="main"
          style={{
            overflow: "auto",
            background: token.colorBgLayout,
            transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  );
}