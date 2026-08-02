import { useMemo } from "react";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Badge, Layout, Menu, Select, Space, Tag, Typography } from "antd";
import {
  BookOutlined,
  DashboardOutlined,
  EditOutlined,
  NodeIndexOutlined,
  ReadOutlined,
  SafetyCertificateOutlined,
  SettingOutlined,
  DatabaseOutlined,
} from "@ant-design/icons";
import { useAppStore } from "../../store/useAppStore";

const { Sider, Header, Content } = Layout;

const NAV_ITEMS = [
  { key: "/dashboard", icon: <DashboardOutlined />, label: "仪表盘" },
  { key: "/writing", icon: <EditOutlined />, label: "创作驾驶舱" },
  { key: "/reader", icon: <ReadOutlined />, label: "阅读器" },
  { key: "/graph", icon: <NodeIndexOutlined />, label: "叙事图谱" },
  { key: "/review", icon: <SafetyCertificateOutlined />, label: "章节审查" },
  { key: "/library", icon: <DatabaseOutlined />, label: "资料库" },
  { key: "/settings", icon: <SettingOutlined />, label: "设置" },
];

const apiStatusConfig = {
  loading: { status: "processing" as const, text: "检测中" },
  online: { status: "success" as const, text: "API 在线" },
  offline: { status: "error" as const, text: "API 离线" },
};

export default function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const {
    apiStatus,
    projects,
    selectedProjectRef,
    selectProject,
  } = useAppStore();

  const selectedKey = useMemo(() => {
    const match = NAV_ITEMS.find((item) => location.pathname.startsWith(item.key));
    return match?.key ?? "/dashboard";
  }, [location.pathname]);

  const status = apiStatusConfig[apiStatus];

  return (
    <Layout style={{ minHeight: "100vh" }}>
      <Sider
        theme="light"
        width={220}
        style={{ borderRight: "1px solid #e6dccb", padding: "12px 8px" }}
      >
        <div style={{ padding: "8px 12px 16px" }}>
          <Space align="center" size={8}>
            <BookOutlined style={{ fontSize: 22, color: "#5f4b32" }} />
            <Typography.Title level={4} style={{ margin: 0, color: "#493821" }}>
              Braipen
            </Typography.Title>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            小说创作工作台
          </Typography.Text>
        </div>

        <div style={{ padding: "0 4px 12px" }}>
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, display: "block", marginBottom: 6, paddingLeft: 4 }}
          >
            当前项目
          </Typography.Text>
          <Select
            showSearch
            allowClear
            placeholder="选择或创建项目"
            style={{ width: "100%" }}
            size="middle"
            value={selectedProjectRef ?? undefined}
            onChange={(value) => selectProject(value ?? null)}
            optionFilterProp="label"
            options={projects.map((project) => ({
              value: project.project_ref,
              label: project.title || project.project_ref,
            }))}
          />
        </div>

        <Menu
          mode="inline"
          selectedKeys={[selectedKey]}
          items={NAV_ITEMS}
          onClick={({ key }) => navigate(key)}
          style={{ borderInlineEnd: "none", background: "transparent" }}
        />
      </Sider>

      <Layout>
        <Header
          style={{
            background: "#f4efe6",
            borderBottom: "1px solid #e6dccb",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            paddingInline: 24,
            height: 56,
            lineHeight: "56px",
          }}
        >
          <div>
            <Typography.Text strong style={{ fontSize: 15 }}>
              {NAV_ITEMS.find((item) => item.key === selectedKey)?.label ?? "Braipen"}
            </Typography.Text>
          </div>
          <Space size={12}>
            {selectedProjectRef && (
              <Tag color="geekblue" style={{ marginInlineEnd: 0 }}>
                {projects.find((p) => p.project_ref === selectedProjectRef)?.title ?? selectedProjectRef}
              </Tag>
            )}
            <Badge status={status.status} text={status.text} />
          </Space>
        </Header>
        <Content style={{ padding: 0 }}>
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
