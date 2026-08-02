import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Alert,
  Badge,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Select,
  Space,
  Spin,
  Tabs,
  Typography,
  message,
} from "antd";
import {
  ApiOutlined,
  KeyOutlined,
  ReloadOutlined,
  SaveOutlined,
  SettingOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { getApiConfigStatus, getGenerationStatus, saveApiConfig, testApiConnection, updateGenerationSettings } from "../api";
import { useAppStore } from "../store/useAppStore";
import { API_BASE_URL } from "../api";

const MODEL_OPTIONS = [
  { value: "deepseek-v4-flash", label: "deepseek-v4-flash（默认，快速）" },
  { value: "deepseek-v4-pro", label: "deepseek-v4-pro（更高质量）" },
];

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

  // API 密钥配置
  const [apiConfigForm] = Form.useForm();
  const [apiConfigStatus, setApiConfigStatus] = useState<{
    configured: boolean;
    source: string;
    default_model: string;
    base_url: string;
  } | null>(null);
  const [apiConfigLoading, setApiConfigLoading] = useState(false);
  const [savingApiConfig, setSavingApiConfig] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);

  const loadApiConfigStatus = useCallback(async () => {
    if (apiStatus !== "online") {
      return;
    }
    setApiConfigLoading(true);
    try {
      const result = await getApiConfigStatus();
      setApiConfigStatus({
        configured: result.configured,
        source: result.source,
        default_model: result.default_model,
        base_url: result.base_url,
      });
      apiConfigForm.setFieldsValue({
        default_model: result.default_model || "deepseek-v4-flash",
        base_url: result.base_url || "",
      });
    } catch {
      // 状态读取失败不打断页面
    } finally {
      setApiConfigLoading(false);
    }
  }, [apiConfigForm, apiStatus]);

  useEffect(() => {
    void loadApiConfigStatus();
  }, [loadApiConfigStatus]);

  const handleSaveApiConfig = useCallback(async () => {
    setSavingApiConfig(true);
    try {
      const values = await apiConfigForm.validateFields();
      const hasNewKey = Boolean(values.api_key && values.api_key.trim());
      const result = await saveApiConfig({
        api_key: values.api_key || "",
        default_model: values.default_model || "deepseek-v4-flash",
        base_url: values.base_url || "",
        // 留空 Key 时允许仅更新模型/Base URL（保留现有 Key）
        require_api_key: hasNewKey,
      });
      message.success(result.message || "API 配置已保存。");
      apiConfigForm.setFieldValue("api_key", "");
      void loadApiConfigStatus();
    } catch (e) {
      if (e instanceof Error && "errorFields" in e) {
        return;
      }
      message.error(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setSavingApiConfig(false);
    }
  }, [apiConfigForm, loadApiConfigStatus]);

  const handleTestConnection = useCallback(async () => {
    setTestingConnection(true);
    try {
      const apiKey = apiConfigForm.getFieldValue("api_key") || "";
      const model = apiConfigForm.getFieldValue("default_model") || "deepseek-v4-flash";
      const result = await testApiConnection({ api_key: apiKey, model });
      if (result.ok) {
        message.success(result.message || "连接成功。");
      } else {
        message.error(result.message || "连接失败。");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "测试失败。");
    } finally {
      setTestingConnection(false);
    }
  }, [apiConfigForm]);

  const config = selectedProject?.config ?? {};
  const configModel = typeof config.model === "string" ? config.model : "";
  const configMaxTokens = typeof config.max_tokens === "number" ? config.max_tokens : 16384;
  const configTemperature = typeof config.temperature === "number" ? config.temperature : 1.0;

  const status = apiStatusConfig[apiStatus];

  const refreshGenerationStatus = useCallback(async () => {
    if (apiStatus !== "online") {
      return;
    }
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
        model: values.model as "deepseek-v4-flash" | "deepseek-v4-pro",
        max_tokens: values.max_tokens,
        temperature: values.temperature,
      });
      message.success("项目生成设置已保存。");
    } catch (e) {
      if (e instanceof Error && "errorFields" in e) {
        return;
      }
      message.error(e instanceof Error ? e.message : "保存失败。");
    } finally {
      setSaving(false);
    }
  }, [form, selectedProjectRef]);

  const apiKeyTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card
        size="small"
        title={
          <Space>
            <KeyOutlined style={{ color: "#5f4b32" }} />
            <span>API 密钥</span>
          </Space>
        }
      >
        {apiConfigLoading ? (
          <Spin />
        ) : (
          <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="当前状态">
              {apiConfigStatus?.configured ? (
                <Badge status="success" text={`已配置（来源：${apiConfigStatus.source === "environment" ? "环境变量" : ".env" }）`} />
              ) : (
                <Badge status="warning" text="未配置" />
              )}
            </Descriptions.Item>
            {apiConfigStatus?.configured && (
              <>
                <Descriptions.Item label="默认模型">{apiConfigStatus.default_model}</Descriptions.Item>
                <Descriptions.Item label="Base URL">
                  <code>{apiConfigStatus.base_url}</code>
                </Descriptions.Item>
              </>
            )}
          </Descriptions>
        )}

        <Form form={apiConfigForm} layout="vertical">
          <Form.Item
            name="api_key"
            label="DeepSeek API Key（留空表示保留现有 Key，仅修改下方选项）"
            rules={[{ max: 300 }]}
          >
            <Input.Password
              placeholder="sk-..."
              autoComplete="new-password"
              style={{ maxWidth: 480 }}
            />
          </Form.Item>
          <Form.Item name="default_model" label="默认模型" rules={[{ required: true }]}>
            <Select
              options={[
                { value: "deepseek-v4-flash", label: "deepseek-v4-flash（默认，快速）" },
                { value: "deepseek-v4-pro", label: "deepseek-v4-pro（更高质量）" },
              ]}
              style={{ maxWidth: 480 }}
            />
          </Form.Item>
          <Form.Item name="base_url" label="Base URL">
            <Input placeholder="https://api.deepseek.com" style={{ maxWidth: 480 }} />
          </Form.Item>
          <Space>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={() => void handleSaveApiConfig()}
              loading={savingApiConfig}
            >
              保存配置
            </Button>
            <Button
              icon={<ThunderboltOutlined />}
              onClick={() => void handleTestConnection()}
              loading={testingConnection}
            >
              测试连接
            </Button>
          </Space>
          <Alert
            type="info"
            showIcon
            message="API Key 只写入本地 .env 文件，不会显示明文，也不会提交到代码仓库。"
            style={{ marginTop: 12 }}
          />
        </Form>
      </Card>
    </div>
  );

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
            <Descriptions.Item label="running">{generationStatus.running ? "true" : "false"}</Descriptions.Item>
            <Descriptions.Item label="task_type">{generationStatus.task_type || "-"}</Descriptions.Item>
            <Descriptions.Item label="target">{generationStatus.target || "-"}</Descriptions.Item>
            {generationStatus.last_error && (
              <Descriptions.Item label="last_error">
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

      <Card size="small" title="启动方式">
        <Descriptions column={1} size="small" bordered>
          <Descriptions.Item label="官方前端">React + FastAPI（start-react.bat）</Descriptions.Item>
          <Descriptions.Item label="旧 Streamlit">已废弃（start.bat 会自动转向 React）</Descriptions.Item>
        </Descriptions>
      </Card>
    </div>
  );

  const projectTab = (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card size="small" title="项目生成设置">
        {!selectedProjectRef ? (
          <Alert type="info" showIcon message="请先在左侧选择项目。" action={<Button size="small" onClick={() => navigate("/writing")}>去选择</Button>} />
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
              <Select options={MODEL_OPTIONS} />
            </Form.Item>
            <Form.Item
              name="max_tokens"
              label="max_tokens（推理模型需 ≥ 16384 才能稳定产出正文）"
              rules={[{ required: true, type: "number", min: 512, max: 32768 }]}
            >
              <InputNumber min={512} max={32768} step={1024} style={{ width: "100%" }} />
            </Form.Item>
            <Form.Item name="temperature" label="temperature" rules={[{ required: true, type: "number", min: 0, max: 2 }]}>
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
    <div style={{ padding: 20 }}>
      <Card
        title={
          <Space>
            <SettingOutlined style={{ color: "#5f4b32" }} />
            <span>设置</span>
          </Space>
        }
        styles={{ body: { paddingTop: 12 } }}
      >
        <Tabs
          items={[
            { key: "api", label: "API 密钥", children: apiKeyTab },
            { key: "system", label: "系统设置", children: systemTab },
            { key: "project", label: "项目设置", children: projectTab },
          ]}
        />
      </Card>
    </div>
  );
}
