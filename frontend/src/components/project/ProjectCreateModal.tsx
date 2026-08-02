import { useState } from "react";
import { Alert, Form, Input, Modal, Select, Slider, message } from "antd";
import type { CreateProjectRequest } from "../../types";
import { createProject } from "../../api";

const MODEL_OPTIONS = [
  { value: "deepseek-v4-flash", label: "deepseek-v4-flash（快速）" },
  { value: "deepseek-v4-pro", label: "deepseek-v4-pro（深度）" },
];

const GENRE_OPTIONS = [
  "玄幻",
  "仙侠",
  "都市",
  "科幻",
  "悬疑",
  "历史",
  "言情",
  "奇幻",
  "现实",
  "其他",
];

type ProjectCreateModalProps = {
  open: boolean;
  onClose: () => void;
  onCreated: (projectRef: string) => void;
};

export default function ProjectCreateModal({ open, onClose, onCreated }: ProjectCreateModalProps) {
  const [form] = Form.useForm<CreateProjectRequest>();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      setSubmitting(true);
      setError("");
      const result = await createProject(values);
      message.success(result.message || "项目创建成功");
      form.resetFields();
      onCreated(result.project_ref);
    } catch (e) {
      const unknownError = e as unknown;
      if (
        unknownError instanceof Error &&
        "errorFields" in (unknownError as Error & { errorFields?: unknown })
      ) {
        return;
      }
      setError(e instanceof Error ? e.message : "创建项目失败。");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      title="创建小说项目"
      open={open}
      onOk={() => void handleOk()}
      onCancel={onClose}
      okText="创建"
      cancelText="取消"
      confirmLoading={submitting}
      width={560}
      destroyOnClose
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          seedPrompt: "",
          model: "deepseek-v4-flash",
          maxTokens: 8192,
          temperature: 1.0,
        }}
        style={{ marginTop: 8 }}
      >
        {error && <Alert type="error" message={error} showIcon style={{ marginBottom: 12 }} />}

        <Form.Item
          name="title"
          label="书名"
          rules={[{ required: true, message: "请输入书名" }, { max: 60, message: "书名过长" }]}
        >
          <Input placeholder="例如：灰剧场" />
        </Form.Item>

        <Form.Item
          name="seedPrompt"
          label="创作种子（故事起点）"
          rules={[{ required: true, message: "请描述故事起点" }]}
        >
          <Input.TextArea
            rows={4}
            placeholder="例如：一个在废弃剧场后台长大的少女，偶然发现剧场地下藏着一整座消失的城市……"
          />
        </Form.Item>

        <Form.Item name="genre" label="题材">
          <Select
            allowClear
            placeholder="选择题材（可选）"
            options={GENRE_OPTIONS.map((genre) => ({ value: genre, label: genre }))}
          />
        </Form.Item>

        <Form.Item name="style" label="文风（可选）">
          <Input placeholder="例如：冷峻克制的悬疑笔调，短句，少用形容词" />
        </Form.Item>

        <Form.Item name="model" label="模型">
          <Select options={MODEL_OPTIONS} />
        </Form.Item>

        <Form.Item name="maxTokens" label="单次生成上限（token）">
          <Input type="number" min={1024} max={32768} step={1024} />
        </Form.Item>

        <Form.Item name="temperature" label={`创作温度：${form.getFieldValue("temperature") ?? 1.0}`}>
          <Slider min={0} max={2} step={0.1} marks={{ 0: "保守", 1: "平衡", 2: "发散" }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}
