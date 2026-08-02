import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Alert, Button, Empty, List, Popconfirm, Spin, Typography } from "antd";
import { ClockCircleOutlined, PlusOutlined } from "@ant-design/icons";
import { deleteProject } from "../../api";
import { useProjects } from "../../hooks/useProjectData";
import { useAppStore } from "../../store/useAppStore";
import ProjectCreateModal from "./ProjectCreateModal";

function formatUpdatedAt(value: string): string {
  if (!value) {
    return "";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function ProjectListPanel() {
  const navigate = useNavigate();
  const { projects, projectsLoading, selectedProjectRef, selectProject, setProjects, clearProjectState } =
    useAppStore();
  const { error, refresh } = useProjects();
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleCreateSuccess = (ref: string) => {
    setCreateOpen(false);
    void refresh().then(() => {
      selectProject(ref);
      navigate("/writing");
    });
  };

  const handleDelete = async (ref: string) => {
    setDeleting(true);
    setDeleteError("");
    try {
      await deleteProject(ref);
      if (selectedProjectRef === ref) {
        // 删除的是当前项目：清空全部相关状态
        clearProjectState();
      }
      setProjects(projects.filter((project) => project.project_ref !== ref));
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "删除项目失败。");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, minHeight: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Typography.Text strong>项目列表</Typography.Text>
        <Button
          type="primary"
          size="small"
          icon={<PlusOutlined />}
          onClick={() => setCreateOpen(true)}
        >
          新建
        </Button>
      </div>

      {error && <Alert type="error" message={error} showIcon closable />}
      {deleteError && <Alert type="error" message={deleteError} showIcon closable />}

      <div style={{ overflowY: "auto", flex: 1, minHeight: 0 }}>
        {projectsLoading && projects.length === 0 ? (
          <div style={{ textAlign: "center", padding: 24 }}>
            <Spin />
          </div>
        ) : projects.length === 0 ? (
          <Empty description="还没有项目，点击新建开始创作" image={Empty.PRESENTED_IMAGE_SIMPLE} />
        ) : (
          <List
            size="small"
            dataSource={projects}
            renderItem={(project) => {
              const active = project.project_ref === selectedProjectRef;
              return (
                <List.Item
                  style={{
                    padding: "8px 10px",
                    borderRadius: 8,
                    cursor: "pointer",
                    background: active ? "#efe4d3" : "transparent",
                    border: active ? "1px solid #d8c7a8" : "1px solid transparent",
                  }}
                  onClick={() => selectProject(project.project_ref)}
                  actions={[
                    <Popconfirm
                      key="delete"
                      title="删除项目"
                      description="将删除该项目及其全部章节文件，此操作不可恢复。"
                      okText="删除"
                      okButtonProps={{ danger: true }}
                      cancelText="取消"
                      onConfirm={(event) => {
                        event?.stopPropagation();
                        void handleDelete(project.project_ref);
                      }}
                      onCancel={(event) => event?.stopPropagation()}
                    >
                      <Button
                        type="text"
                        size="small"
                        danger
                        disabled={deleting}
                        onClick={(event) => event.stopPropagation()}
                      >
                        删除
                      </Button>
                    </Popconfirm>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <Typography.Text strong={active} onClick={() => selectProject(project.project_ref)}>
                        {project.title || project.project_ref}
                      </Typography.Text>
                    }
                    description={
                      <span style={{ fontSize: 12, color: "#9a8f80" }}>
                        <ClockCircleOutlined /> {formatUpdatedAt(project.updated_at)}
                      </span>
                    }
                  />
                </List.Item>
              );
            }}
          />
        )}
      </div>

      <ProjectCreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreateSuccess}
      />
    </div>
  );
}
