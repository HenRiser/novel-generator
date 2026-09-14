import { useState } from "react";
import { Alert, App, Collapse, Form, Input, InputNumber, Modal, Select, Slider } from "antd";
import type { CreateProjectRequest } from "../../types";
import { createProject } from "../../api";

const GENRES = ["玄幻", "仙侠", "都市", "科幻", "悬疑", "历史", "言情", "奇幻", "现实", "其他"];
type Props = { open: boolean; onClose: () => void; onCreated: (projectRef: string) => void };
export default function ProjectCreateModal({ open, onClose, onCreated }: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<CreateProjectRequest>();
  const temperature = Form.useWatch("temperature", form) ?? 1;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const handleCreate = async () => {
    let values: CreateProjectRequest;
    try { values = await form.validateFields(); } catch { return; }
    setSubmitting(true); setError("");
    try {
      const result = await createProject({ ...values, title: values.title.trim(), seedPrompt: values.seedPrompt.trim() });
      message.success("故事已建立，开始展开你的世界。");
      form.resetFields(); onCreated(result.project_ref);
    } catch (e) { setError(e instanceof Error ? e.message : "创建失败，请稍后重试。"); }
    finally { setSubmitting(false); }
  };
  return <Modal title="每个故事，都始于一个念头。" open={open} onOk={() => void handleCreate()} onCancel={() => { if (!submitting) { setError(""); onClose(); } }} okText="建立故事" cancelText="再想想" confirmLoading={submitting} closable={!submitting} keyboard={!submitting} mask={{ closable: !submitting }} cancelButtonProps={{ disabled: submitting }} width={600}>
    <p className="project-create-intro">给它一个名字，写下最想讲述的那个瞬间。<br />创建后，可以继续生成大纲、构建人物与规划章节。</p>
    <Form form={form} layout="vertical" initialValues={{ seedPrompt: "", model: "deepseek-v4-flash", maxTokens: 16384, temperature: 1 }} requiredMark="optional">
      {error && <Alert type="error" title={error} showIcon style={{ marginBottom: 18 }} />}
      <Form.Item name="title" label="故事的名字" rules={[{ required: true, whitespace: true, message: "给故事起一个名字" }, { max: 60, message: "书名请控制在 60 字以内" }]}><Input placeholder="例如：长夜来信" maxLength={60} /></Form.Item>
      <Form.Item name="seedPrompt" label="故事的起点" rules={[{ required: true, whitespace: true, message: "写下一点灵感，让故事开始" }]}><Input.TextArea rows={4} placeholder="在一座永不入夜的城市，一位修钟师收到了一封来自明天的信……" /></Form.Item>
      <div className="form-two-columns"><Form.Item name="genre" label="题材"><Select allowClear placeholder="选择题材" options={GENRES.map(value => ({ value, label: value }))} /></Form.Item><Form.Item name="style" label="文风"><Input placeholder="例如：克制、细腻，带一点诗意" /></Form.Item></div>
      <Collapse ghost items={[{ key: "settings", label: "生成偏好 · 随时可以调整", forceRender: true, children: <>
        <Form.Item name="model" label="模型"><Select options={[{ value: "deepseek-v4-flash", label: "DeepSeek V4 Flash" }, { value: "deepseek-v4-pro", label: "DeepSeek V4 Pro" }]} /></Form.Item>
        <Form.Item name="maxTokens" label="单次输出预算（token）" extra="预算会同时影响推理与正文的可用空间，不等同于中文字数。" rules={[{ required: true, type: "number", min: 1024, max: 32768 }]}><InputNumber min={1024} max={32768} step={1024} style={{ width: "100%" }} /></Form.Item>
        <Form.Item name="temperature" label={`创作温度 · ${temperature.toFixed(1)}`}><Slider min={0} max={2} step={0.1} marks={{ 0: "收敛", 1: "平衡", 2: "发散" }} /></Form.Item>
      </> }]} />
    </Form>
  </Modal>;
}
