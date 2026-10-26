import { Card, Space, Tag } from "antd";
import { UploadOutlined } from "@ant-design/icons";
import { EmptyState } from "../_shared";

/**
 * 文件传输：服务端协议里没有 FILE_TRANSFER_* 的任何处理（只有类型定义），
 * 旧实现却在本地消费 FileReader 进度并弹「发送完成」——典型的假成功。
 * 契约 §1.3/§6.3 要求如实呈现，因此在服务端落地前这里只说明"不可用"，
 * 不再提供会产生误导的发送/接受按钮。
 */
export function FileTransferPanel() {
  return (
    <Card
      title={
        <Space>
          <UploadOutlined />
          <span>文件传输</span>
          <Tag color="default">未实现</Tag>
        </Space>
      }
      size="small"
    >
      <EmptyState
        title="文件传输暂不可用"
        description="服务端尚未实现文件通道（仅客户端有类型定义），为避免误报「发送成功」，本版本不提供传输入口。可先用系统自带的方式（如共享目录、网盘）传递文件。"
        icon={<UploadOutlined style={{ fontSize: 48, color: "#555" }} />}
      />
    </Card>
  );
}
