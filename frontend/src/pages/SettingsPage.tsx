import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  App as AntApp,
  Badge,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Space,
  Spin,
  Switch,
  Tabs,
  Typography,
} from "antd";
import {
  ApiOutlined,
  ReloadOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { getGenerationStatus, updateGenerationSettings } from "../api";
import { useAppStore } from "../store/useAppStore";
import { API_BASE_URL } from "../api";
import { useProjectData, useProjects } from "../hooks/useProjectData";
import { isIntroHidden, setIntroHidden } from "../appConfig";
import ProviderConnectionsPanel from "../components/ProviderConnectionsPanel";
import ConnectionPicker from "../components/ConnectionPicker";
import LocalDataPanel from "../components/LocalDataPanel";

const apiStatusConfig = {
  loading: { status: "processing" as const, text: "检测中" },
  online: { status: "success" as const, text: "API 在线" },
  offline: { status: "error" as const, text: "API 离线" },
};

type GenerationSettingsForm = {
  model: string;
  max_tokens: number;
  temperature: number;
};

export default function SettingsPage() {
  const { message } = AntApp.useApp();
  const navigate = useNavigate();
  const {
    apiStatus,
    selectedProjectRef,
    selectedProject,
    projectLoading,
    generationStatus,
    generationStatusLoading,
    setGenerationStatus,
    setGenerationStatusLoading,
  } = useAppStore();
  const [form] = Form.useForm<GenerationSettingsForm>();
  const [saving, setSaving] = useState(false);
  const [activeTab, setActiveTab] = useState("api");
  const [hideIntro, setHideIntro] = useState(isIntroHidden);
  const { refreshProject, detailError } = useProjectData(selectedProjectRef);
  const { refresh: refreshProjects } = useProjects();

  const config = selectedProject?.config ?? {};
  const configModel = typeof config.model === "string" ? config.model : "";
  const configMaxTokens = typeof config.max_tokens === "number" ? config.max_tokens : 16384;
  const configTemperature = typeof config.temperature === "number" ? config.temperature : 1.0;
  useEffect(() => {
    if (activeTab !== "project" || !selectedProjectRef || projectLoading) return;
    form.setFieldsValue({ model: configModel || "deepseek-v4-flash", max_tokens: configMaxTokens, temperature: configTemperature });
  }, [form, activeTab, projectLoading, selectedProjectRef, configModel, configMaxTokens, configTemperature]);

  const status = apiStatusConfig[apiStatus];

  const refreshGenerationStatus = useCallback(async () => {
    setGenerationStatusLoading(true);
    try {
      const result = await getGenerationStatus();
      setGenerationStatus(result);
    } catch {
      // 状态读取失败不打断页面
    } finally {
      setGenerationStatusLoading(false);
    }
  }, [apiStatus, setGenerationStatus, setGenerationStatusLoading]);

  useEffect(() => {
    void refreshGenerationStatus();
  }, [refreshGenerationStatus]);

  const handleSaveProjectSettings = useCallback(async () => {
    if (!selectedProjectRef) {
      message.warning("请先选择项目。");
      return;
    }
    setSaving(true);
    try {
      const values = await form.validateFields();
      await updateGenerationSettings(selectedProjectRef, {
        model: values.model,
        max_tokens: values.max_tokens,
        temperature: values.temperature,
      });
      if (useAppStore.getState().selectedProjectRef === selectedProjectRef) {
        message.success("项目生成设置已保存。");
        await refreshProject();
      }
    } catch (e) {
      if (e instanceof Error && "errorFields" in e) {
        return;
      }
      message.error(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }, [form, selectedProjectRef, refreshProject]);

  const apiKeyTab = <ProviderConnectionsPanel />;

  const systemTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card
        size="small"
        title={
          <Space>
            <ApiOutlined style={{ color: "#5f4b32" }} />
            <span>后端状态</span>
          </Space>
        }
      >
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="状态">
            <Badge status={status.status} text={status.text} />
          </Descriptions.Item>
          <Descriptions.Item label="API Base URL">
            <code>{API_BASE_URL}</code>
          </Descriptions.Item>
          <Descriptions.Item label="健康检查">
            {apiStatus === "online" ? "ok" : apiStatus === "offline" ? "unavailable" : "checking"}
          </Descriptions.Item>
        </Descriptions>
        {apiStatus === "offline" && (
          <Alert type="error" showIcon message="无法连接后端 API，请先启动 FastAPI 服务。" style={{ marginTop: 8 }} />
        )}
      </Card>

      <Card
        size="small"
        title={
          <Space>
            <ReloadOutlined style={{ color: "#5f4b32" }} />
            <span>生成状态</span>
          </Space>
        }
        extra={
          <Button
            size="small"
            icon={<ReloadOutlined />}
            onClick={() => void refreshGenerationStatus()}
            loading={generationStatusLoading}
            disabled={apiStatus !== "online"}
          >
            刷新
          </Button>
        }
      >
        {generationStatus ? (
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="进行中">{generationStatus.running ? "true" : "false"}</Descriptions.Item>
            <Descriptions.Item label="任务类型">{generationStatus.task_type || "-"}</Descriptions.Item>
            <Descriptions.Item label="目标">{generationStatus.target || "-"}</Descriptions.Item>
            {generationStatus.last_error && (
              <Descriptions.Item label="最近错误">
                <Typography.Text type="danger" style={{ fontSize: 12 }}>
                  {generationStatus.last_error}
                </Typography.Text>
              </Descriptions.Item>
            )}
          </Descriptions>
        ) : (
          <Typography.Text type="secondary">暂无生成状态。</Typography.Text>
        )}
      </Card>

      <LocalDataPanel onProjectsChanged={refreshProjects} />

      <Card size="small" title="进场体验">
        <Space><Switch checked={hideIntro} onChange={value => { setHideIntro(value); setIntroHidden(value); }} aria-label="隐藏自动开场" /><span>隐藏自动开场</span></Space>
        <p className="page-subtitle" style={{ margin: "12px 0 0" }}>默认只在首次访问播放。随时可以通过页脚“重播开场”再次观看。</p>
      </Card>
    </div>
  );

  const projectTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <ConnectionPicker projectRef={selectedProjectRef} onChanged={refreshProject} />
      <Card size="small" title="项目生成设置">
        {!selectedProjectRef ? (
          <Alert type="info" showIcon message="请先在顶部选择项目。" action={<Button size="small" onClick={() => navigate("/writing")}>去选择</Button>} />
        ) : projectLoading ? (
          <Spin />
        ) : (
          <Form
            form={form}
            layout="vertical"
            initialValues={{
              model: configModel || "deepseek-v4-flash",
              max_tokens: configMaxTokens,
              temperature: configTemperature,
            }}
          >
            <Form.Item name="model" label="模型" rules={[{ required: true }]}>
              <Input maxLength={100} placeholder="DeepSeek 模型名" />
            </Form.Item>
            <Form.Item
              name="max_tokens"
              label="单次输出预算（token）"
              extra="预算同时容纳推理与正文，不等同于中文字数。"
              rules={[{ required: true, type: "number", min: 512, max: 32768 }]}
            >
              <InputNumber min={512} max={32768} step={1024} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="temperature" label="创作温度（0 收敛 — 2 发散）" rules={[{ required: true, type: "number", min: 0, max: 2 }]}>
              <InputNumber min={0} max={2} step={0.1} style={{ width: "100%" }} />
            </Form.Item>
            <Button type="primary" icon={<SaveOutlined />} onClick={() => void handleSaveProjectSettings()} loading={saving}>
              保存设置
            </Button>
          </Form>
        )}
      </Card>
    </div>
  );

  return (
    <div className="page-container">
      <div className="page-heading"><div><span className="eyebrow">MAKE IT YOURS</span><h1 className="page-title">偏好设置</h1><p className="page-subtitle">连接你的模型，找到适合自己的创作节奏。</p></div></div>
      {detailError && <Alert type="error" showIcon message={detailError} style={{ marginBottom: 20 }} />}
      <div className="settings-layout">
      <div>
        <Tabs
          activeKey={activeTab}
          onChange={setActiveTab}
          items={[
            { key: "api", label: "模型连接", children: apiKeyTab },
            { key: "project", label: "故事偏好", children: projectTab },
            { key: "system", label: "本地数据与体验", children: systemTab },
          ]}
        />
      </div>
      <aside className="settings-note"><span className="note-number">B / P</span><h3>工具顺手，思想自由。</h3><p>连接配置作用于整个工作空间。故事偏好只影响当前选择的项目，可以在创作台为单次生成调整。</p><p>模型负责给出可能性，取舍由你完成。</p></aside>
      </div>
    </div>
  );
}
