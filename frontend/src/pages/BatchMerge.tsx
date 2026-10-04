import { useMemo, useRef, useState } from 'react';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  CloudUploadOutlined,
  FileTextOutlined,
  RetweetOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Link } from 'react-router-dom';
import { usePointStore } from '../stores/pointStore';
import type { BatchRecord, MergeStats, OfflineBatch, PendingConflict } from '../types/batch';
import { buildInvalidBatch, buildSampleBatch } from '../utils/sampleBatch';

interface MergePreview {
  pointCount: number;
  inspectionCount: number;
  rectifyCount: number;
  batchId: string;
  inspector: string;
  raw: string;
}

export default function BatchMerge() {
  const { message, modal } = App.useApp();
  const importBatch = usePointStore((s) => s.importBatch);
  const resolveConflictAction = usePointStore((s) => s.resolveConflict);
  const batches = usePointStore((s) => s.batches);
  const conflicts = usePointStore((s) => s.conflicts);
  const [raw, setRaw] = useState('');
  const [preview, setPreview] = useState<MergePreview | null>(null);
  const [parseError, setParseError] = useState('');
  const [merging, setMerging] = useState(false);
  const [stats, setStats] = useState<MergeStats | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const openConflicts = useMemo(() => conflicts.filter((c) => !c.resolved), [conflicts]);

  const updateText = (text: string) => {
    setRaw(text);
    setStats(null);
    setParseError('');
    setPreview(null);
    if (!text.trim()) return;
    try {
      const data = JSON.parse(text) as Partial<OfflineBatch>;
      if (!data || typeof data !== 'object') throw new Error('结构为空');
      if (!data.batchId) throw new Error('缺少 batchId');
      setPreview({
        batchId: String(data.batchId),
        inspector: String(data.inspector ?? ''),
        pointCount: Array.isArray(data.points) ? data.points.length : 0,
        inspectionCount: Array.isArray(data.inspections) ? data.inspections.length : 0,
        rectifyCount: Array.isArray(data.rectifies) ? data.rectifies.length : 0,
        raw: text,
      });
    } catch (e) {
      setParseError(e instanceof Error ? e.message : String(e));
    }
  };

  const handleFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => updateText(String(reader.result ?? ''));
    reader.onerror = () => message.error('文件读取失败');
    reader.readAsText(file);
    return false;
  };

  const handleMerge = async () => {
    if (!raw.trim()) {
      message.warning('请先粘贴或选择离线批次文件');
      return;
    }
    setMerging(true);
    setStats(null);
    try {
      const { stats: result, batch } = await importBatch(raw);
      setStats(result);
      message.success(`批次 ${batch.batchId} 已合并：点位、核验、整改一次贴入总览`);
      setRaw('');
      setPreview(null);
    } catch (e) {
      // 整批已撤回：原始文本保留，允许直接修正后重试
      message.error({
        content: `校验失败，整批已撤回：${e instanceof Error ? e.message : String(e)}`,
        duration: 6,
      });
    } finally {
      setMerging(false);
    }
  };

  const fillSample = (kind: 'ok' | 'bad') => {
    const batch = kind === 'ok' ? buildSampleBatch() : buildInvalidBatch();
    updateText(JSON.stringify(batch, null, 2));
  };

  const handleResolve = (row: PendingConflict, pick: 'ledger' | 'site') => {
    modal.confirm({
      title: pick === 'site' ? '采用现场值覆盖台账？' : '确认保留台账值？',
      content:
        pick === 'site'
          ? `将把 ${row.fields.length} 个字段写回点位台账，相关路线判定会重算。`
          : '该待核对条目将关闭，台账值保持不变。',
      okText: pick === 'site' ? '采用现场值' : '保留台账值',
      cancelText: '取消',
      onOk: async () => {
        await resolveConflictAction(row.id, pick);
        message.success(pick === 'site' ? '已采用现场值并完成重算' : '已保留台账值');
      },
    });
  };

  const batchColumns: ColumnsType<BatchRecord> = [
    { title: '批次号', dataIndex: 'batchId', width: 200 },
    { title: '核验员', dataIndex: 'inspector', width: 130, render: (v: string) => v || '—' },
    {
      title: '状态',
      dataIndex: 'status',
      width: 100,
      render: (v: string) =>
        v === '已合并' ? <Tag color="success">已合并</Tag> : <Tag color="error">失败</Tag>,
    },
    {
      title: '点位/核验/整改',
      width: 150,
      render: (_, row) => `${row.pointCount} / ${row.inspectionCount} / ${row.rectifyCount}`,
    },
    { title: '待核对', dataIndex: 'conflictCount', width: 80, render: (v: number) => (v ? <Tag color="warning">{v}</Tag> : 0) },
    {
      title: '处理时间',
      dataIndex: 'mergedAt',
      width: 180,
      render: (v: string) => new Date(v).toLocaleString('zh-CN', { hour12: false }),
    },
    {
      title: '失败原因',
      dataIndex: 'message',
      ellipsis: true,
      render: (v: string) =>
        v ? <Typography.Text type="danger">{v}</Typography.Text> : <Typography.Text type="secondary">—</Typography.Text>,
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h1 className="gb-page-title">离线批次合并</h1>
          <Typography.Text type="secondary">
            核验员离线登记的批次回到内网后整体合并：点位、核验与整改一次贴进总览；
            点位属性以台账为准，双方都改过列待核对，不用现场值覆盖。
          </Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<FileTextOutlined />} onClick={() => fillSample('ok')} data-testid="fill-sample">
            填入演示批次
          </Button>
          <Button icon={<WarningOutlined />} onClick={() => fillSample('bad')} data-testid="fill-invalid">
            填入错误批次
          </Button>
          <Button icon={<RetweetOutlined />} onClick={() => updateText(raw)}>
            重新校验
          </Button>
        </Space>
      </div>

      {stats && (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 16 }}
          message="合并完成"
          data-testid="merge-result"
          description={
            <Row gutter={16}>
              <Col span={6}>新增点位 {stats.pointsAdded}，回填 {stats.pointsUpdated}</Col>
              <Col span={6}>
                新增核验 {stats.inspectionsAdded}，去重 {stats.inspectionsDeduped}
              </Col>
              <Col span={6}>
                整改新增 {stats.rectifiesAdded}
                {stats.rectifiesAutoCreated ? `（自动补建 ${stats.rectifiesAutoCreated}）` : ''} / 更新{' '}
                {stats.rectifiesUpdated} / 重算 {stats.rectifiesRecomputed}
              </Col>
              <Col span={6}>
                待核对 {stats.conflicts}，路线重算 {stats.routesRecomputed}
              </Col>
            </Row>
          }
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card
            title="批次内容（离线端导出的 JSON）"
            size="small"
            extra={
              <Space>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".json,application/json"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                    e.target.value = '';
                  }}
                />
                <Button size="small" onClick={() => fileRef.current?.click()}>
                  选择文件
                </Button>
                <Button
                  size="small"
                  type="primary"
                  icon={<CloudUploadOutlined />}
                  loading={merging}
                  onClick={handleMerge}
                  data-testid="merge-submit"
                >
                  校验并合并
                </Button>
              </Space>
            }
          >
            <Input.TextArea
              value={raw}
              onChange={(e) => updateText(e.target.value)}
              placeholder='粘贴批次 JSON，例如 {"batchId":"OFF-...","points":[...],"inspections":[...],"rectifies":[...]}'
              autoSize={{ minRows: 14, maxRows: 22 }}
              style={{ fontFamily: 'monospace', fontSize: 12 }}
              data-testid="batch-input"
            />
            {parseError && (
              <Alert
                style={{ marginTop: 8 }}
                type="error"
                showIcon
                message={`JSON 解析失败：${parseError}`}
                data-testid="parse-error"
              />
            )}
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card title="合并预检" size="small">
            {preview ? (
              <Space direction="vertical" size={12} style={{ width: '100%' }} data-testid="batch-preview">
                <div>
                  <Typography.Text type="secondary">批次号</Typography.Text>
                  <div style={{ fontWeight: 600 }} data-testid="preview-batch-id">
                    {preview.batchId}
                  </div>
                </div>
                <div>
                  <Typography.Text type="secondary">核验员：{preview.inspector || '—'}</Typography.Text>
                </div>
                <Row gutter={12}>
                  <Col span={8}>
                    <Statistic title="点位" value={preview.pointCount} />
                  </Col>
                  <Col span={8}>
                    <Statistic title="核验" value={preview.inspectionCount} />
                  </Col>
                  <Col span={8}>
                    <Statistic title="整改" value={preview.rectifyCount} />
                  </Col>
                </Row>
                <Typography.Text type="secondary" className="gb-muted">
                  合并时还会做枚举、日期、同人同日去重与引用完整性校验；任一失败整批撤回。
                </Typography.Text>
              </Space>
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="粘贴或选择批次文件后显示预检摘要"
              />
            )}
          </Card>

          <Card title={`待核对（${openConflicts.length}）`} size="small" style={{ marginTop: 16 }}>
            {openConflicts.length ? (
              <Alert
                type="warning"
                showIcon
                style={{ marginBottom: 8 }}
                message="点位属性双方都改过，台账值已保留，请人工核对后决定取舍"
              />
            ) : null}
            <Table<PendingConflict>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={openConflicts}
              locale={{ emptyText: '没有待核对条目' }}
              columns={[
                {
                  title: '点位 / 分歧',
                  render: (_, row) => (
                    <Space direction="vertical" size={2}>
                      <Link to={`/points/${row.pointId}`}>{row.code}</Link>
                      <Space size={4} wrap>
                        {row.fields.map((f) => (
                          <Tag key={f.field} color="orange" style={{ fontSize: 12 }}>
                            {f.fieldLabel} {f.ledger}⇄{f.site}
                          </Tag>
                        ))}
                      </Space>
                      <Space>
                        <Button size="small" onClick={() => handleResolve(row, 'ledger')}>
                          保留台账
                        </Button>
                        <Button size="small" type="primary" ghost danger onClick={() => handleResolve(row, 'site')}>
                          采用现场
                        </Button>
                      </Space>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
      </Row>

      <Card title="批次处理记录" size="small" style={{ marginTop: 16 }}>
        <Table<BatchRecord>
          rowKey="id"
          size="small"
          pagination={{ pageSize: 6, hideOnSinglePage: true }}
          dataSource={batches}
          locale={{ emptyText: '尚未合并过离线批次' }}
          columns={batchColumns}
          rowClassName={(row) => (row.status === '失败' ? 'gb-overdue-row' : '')}
        />
      </Card>
    </div>
  );
}
