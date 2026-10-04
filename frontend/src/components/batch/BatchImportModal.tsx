import { useMemo, useState } from 'react';
import { Alert, App, Button, Descriptions, Input, Modal, Space, Table, Tag, Typography, Upload } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { UploadOutlined, FileTextOutlined, ReloadOutlined } from '@ant-design/icons';
import type { UploadProps } from 'antd';
import { useBatchStore } from '../../stores/batchStore';
import {
  validatePayload,
  type OfflineBatchPayload,
} from '../../utils/batchMerge';
import type { MergeReport, ValidationIssue } from '../../types/batch';

const { TextArea } = Input;

/** 示例离线批次：含新点位、台账点位（台账为准）、重复核验去重、整改状态裁定 */
const SAMPLE_PAYLOAD: OfflineBatchPayload = {
  code: 'BATCH-2025-001',
  registrar: '督导员 李维',
  note: '2025 年秋季离线登记，回到内网后合并',
  points: [
    {
      code: 'WZ-2024-001',
      name: '东单北大街缘石坡道（现场复核名）',
      facilityType: '缘石坡道',
      lng: 116.4185,
      lat: 39.9143,
      district: '东城区',
      location: '东单北大街与灯市口大街交叉口东南角',
      builtYear: 2016,
      maintainUnit: '市政道路养护一所',
    },
    {
      code: 'WZ-2025-101',
      name: '金宝街盲道',
      facilityType: '盲道',
      lng: 116.42,
      lat: 39.915,
      district: '东城区',
      location: '金宝街',
      builtYear: 2020,
      maintainUnit: '市政道路养护二所',
    },
  ],
  inspections: [
    {
      pointCode: 'WZ-2024-001',
      date: '2025-03-12',
      inspector: '督导员 李维',
      slope: 3.2,
      clearWidth: 150,
      hasHandrail: true,
      tactileContinuous: true,
      occupied: '无',
      problem: '',
    },
    {
      pointCode: 'WZ-2025-101',
      date: '2025-10-01',
      inspector: '督导员 王岚',
      slope: 2.0,
      clearWidth: 130,
      hasHandrail: true,
      tactileContinuous: false,
      occupied: '无',
      problem: '盲道断续，路口处断开',
    },
  ],
  rectifies: [
    {
      pointCode: 'WZ-2024-002',
      requirement: '补齐路口断开的盲道并增设提示盲道',
      unit: '市政道路养护二所',
      deadline: '2025-03-08',
      recheckDate: '2025-09-20',
      status: '已整改',
    },
  ],
};

interface ParsedPreview {
  payload: OfflineBatchPayload;
  issues: ValidationIssue[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onImported?: () => void;
}

export default function BatchImportModal({ open, onClose, onImported }: Props) {
  const { message } = App.useApp();
  const importBatch = useBatchStore((s) => s.importBatch);
  const retryBatch = useBatchStore((s) => s.retryBatch);
  const [text, setText] = useState('');
  const [parseError, setParseError] = useState('');
  const [preview, setPreview] = useState<ParsedPreview | null>(null);
  const [importing, setImporting] = useState(false);
  const [report, setReport] = useState<MergeReport | null>(null);
  const [failedBatchId, setFailedBatchId] = useState('');
  const [failReason, setFailReason] = useState('');

  const reset = () => {
    setText('');
    setParseError('');
    setPreview(null);
    setReport(null);
    setFailedBatchId('');
    setFailReason('');
  };

  const handleClose = () => {
    if (importing) return;
    reset();
    onClose();
  };

  const parseText = (raw: string) => {
    setParseError('');
    setReport(null);
    setFailedBatchId('');
    setFailReason('');
    if (!raw.trim()) {
      setPreview(null);
      return;
    }
    try {
      const obj = JSON.parse(raw) as OfflineBatchPayload;
      const issues = validatePayload(obj);
      setPreview({ payload: obj, issues });
    } catch (e) {
      setPreview(null);
      setParseError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleTextChange = (v: string) => {
    setText(v);
    parseText(v);
  };

  const uploadProps: UploadProps = {
    accept: '.json,application/json',
    showUploadList: false,
    beforeUpload: (file) => {
      const reader = new FileReader();
      reader.onload = () => {
        const raw = String(reader.result ?? '');
        setText(raw);
        parseText(raw);
      };
      reader.readAsText(file);
      return false;
    },
  };

  const loadSample = () => {
    const raw = JSON.stringify(SAMPLE_PAYLOAD, null, 2);
    setText(raw);
    parseText(raw);
  };

  const handleImport = async () => {
    if (!preview || preview.issues.length) return;
    setImporting(true);
    try {
      const { report } = await importBatch(preview.payload);
      setReport(report);
      message.success(`批次 ${report.batchCode} 已合并进台账`);
      onImported?.();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      const batchId = (e as Error & { batchId?: string }).batchId ?? '';
      setFailReason(reason);
      setFailedBatchId(batchId);
      message.error('校验失败，整批已撤回，可修改后重试');
    } finally {
      setImporting(false);
    }
  };

  const handleRetry = async () => {
    if (!failedBatchId) return;
    setImporting(true);
    try {
      const { report } = await retryBatch(failedBatchId);
      setReport(report);
      setFailReason('');
      setFailedBatchId('');
      message.success(`批次 ${report.batchCode} 重试成功，已合并`);
      onImported?.();
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setFailReason(reason);
      message.error('重试仍失败，请核对载荷后重新导入');
    } finally {
      setImporting(false);
    }
  };

  const issueColumns: ColumnsType<ValidationIssue> = [
    { title: '类型', dataIndex: 'kind', width: 90, render: (k: string) => <Tag>{k}</Tag> },
    { title: '序号', dataIndex: 'index', width: 70, render: (i: number) => (i < 0 ? '—' : i + 1) },
    { title: '字段', dataIndex: 'field', width: 110 },
    { title: '问题', dataIndex: 'message' },
  ];

  const counts = useMemo(() => {
    if (!preview) return null;
    const p = preview.payload;
    return {
      points: p.points?.length ?? 0,
      inspections: p.inspections?.length ?? 0,
      rectifies: p.rectifies?.length ?? 0,
    };
  }, [preview]);

  return (
    <Modal
      title="导入离线登记批次"
      open={open}
      onCancel={handleClose}
      width={760}
      footer={
        <Space>
          <Button onClick={handleClose}>关闭</Button>
          {failedBatchId ? (
            <Button icon={<ReloadOutlined />} loading={importing} onClick={handleRetry}>
              重试本批
            </Button>
          ) : null}
          <Button
            type="primary"
            icon={<FileTextOutlined />}
            loading={importing}
            disabled={!preview || preview.issues.length > 0 || Boolean(report)}
            onClick={handleImport}
          >
            确认合并
          </Button>
        </Space>
      }
    >
      {report ? (
        <Alert
          type="success"
          showIcon
          message="批次已合并进台账"
          description={
            <Descriptions column={2} size="small" style={{ marginTop: 8 }}>
              <Descriptions.Item label="批次编号">{report.batchCode}</Descriptions.Item>
              <Descriptions.Item label="待核对点位">{report.pointsConflict} 处</Descriptions.Item>
              <Descriptions.Item label="新增点位">{report.pointsNew} 处</Descriptions.Item>
              <Descriptions.Item label="新增核验">{report.inspectionsNew} 次</Descriptions.Item>
              <Descriptions.Item label="去重核验">{report.inspectionsDeduped} 次</Descriptions.Item>
              <Descriptions.Item label="新增整改">{report.rectifiesNew} 条</Descriptions.Item>
              <Descriptions.Item label="更新整改">{report.rectifiesUpdated} 条</Descriptions.Item>
              <Descriptions.Item label="路线重算">{report.routesRecalculated} 段</Descriptions.Item>
            </Descriptions>
          }
        />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Space wrap>
            <Upload {...uploadProps}>
              <Button icon={<UploadOutlined />}>选择 JSON 文件</Button>
            </Upload>
            <Button onClick={loadSample}>填入示例批次</Button>
            <Typography.Text type="secondary" className="gb-muted">
              支持直接粘贴离线登记导出的 JSON
            </Typography.Text>
          </Space>

          <TextArea
            rows={10}
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder='粘贴批次 JSON，格式：{"code":"...","points":[...],"inspections":[...],"rectifies":[...]}'
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />

          {parseError ? <Alert type="error" showIcon message="JSON 解析失败" description={parseError} /> : null}

          {preview && !parseError ? (
            preview.issues.length ? (
              <Alert
                type="warning"
                showIcon
                message={`校验未通过（${preview.issues.length} 项），整批不会写入，可修改后重试`}
                description={
                  <Table<ValidationIssue>
                    rowKey={(r) => `${r.kind}-${r.index}-${r.field}`}
                    size="small"
                    pagination={false}
                    dataSource={preview.issues}
                    columns={issueColumns}
                    style={{ marginTop: 8 }}
                  />
                }
              />
            ) : (
              <Alert
                type="info"
                showIcon
                message="校验通过，确认后整批合并"
                description={
                  <Space size={16} wrap style={{ marginTop: 4 }}>
                    <Tag color="blue">点位 {counts?.points}（新增 {preview.payload.points?.filter((p) => p.code).length ?? 0}）</Tag>
                    <Tag color="cyan">核验 {counts?.inspections}</Tag>
                    <Tag color="geekblue">整改 {counts?.rectifies}</Tag>
                    <Typography.Text type="secondary" className="gb-muted">
                      点位属性以台账为准，双方都改过列入待核对；同一人同日核验去重；整改状态按更新时间与复检日期取更晚有效值。
                    </Typography.Text>
                  </Space>
                }
              />
            )
          ) : null}

          {failReason ? (
            <Alert
              type="error"
              showIcon
              message="上一批次合并失败，已整批撤回"
              description={
                <Space direction="vertical" size={4}>
                  <Typography.Text>{failReason}</Typography.Text>
                  <Typography.Text type="secondary" className="gb-muted">
                    可修改上方 JSON 后重新合并，或点击「重试本批」用暂存载荷重试。
                  </Typography.Text>
                </Space>
              }
            />
          ) : null}
        </Space>
      )}
    </Modal>
  );
}
