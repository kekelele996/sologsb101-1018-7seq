/**
 * /vats 调漆缸台账与按缸号对账
 * 调漆间按缸登记漆种、配方与容量；髹涂组按缸领用道次并扣减余量。
 * 容量用满排队等下一缸；缸结皮作废后未涂完的道次退回待涂；两边按缸号对账，对不上的挂起等人定。
 * 消费 Vat、Coat；复用 <StatBadge>、<EmptyPanel>。
 */
import { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  DeleteOutlined,
  EditOutlined,
  ExperimentOutlined,
  PlusOutlined,
  StopOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import { useCoatStore } from '@/stores/coatStore';
import { useVatStore } from '@/stores/vatStore';
import { PAINT_TYPE_LABEL, PAINT_TYPE_OPTIONS, type PaintType } from '@/types/coat';
import {
  LEGACY_VAT_ID,
  VAT_STATE_COLOR,
  VAT_STATE_LABEL,
  VAT_STATE_OPTIONS,
  createEmptyVatDraft,
  generateVatCode,
  type Vat,
  type VatDraft,
  type VatState,
} from '@/types/vat';
import { vatShortage } from '@/utils/vat';

export default function VatBoard() {
  const { message, modal } = AntdApp.useApp();
  const [form] = Form.useForm<VatDraft>();

  const vats = useVatStore((state) => state.vats);
  const loadVats = useVatStore((state) => state.loadVats);
  const createVat = useVatStore((state) => state.createVat);
  const updateVat = useVatStore((state) => state.updateVat);
  const removeVat = useVatStore((state) => state.removeVat);
  const voidVat = useVatStore((state) => state.voidVat);
  const reconciliation = useVatStore((state) => state.reconciliation);

  const coats = useCoatStore((state) => state.coats);
  const loadCoats = useCoatStore((state) => state.loadCoats);

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Vat | null>(null);

  useEffect(() => {
    void loadVats();
    void loadCoats();
  }, [loadVats, loadCoats]);

  const recon = useMemo(() => reconciliation(coats), [reconciliation, coats]);

  const stats = useMemo(() => {
    const active = vats.filter((vat) => vat.state === 'active' && vat.id !== LEGACY_VAT_ID);
    const totalCapacity = active.reduce((sum, vat) => sum + vat.capacity, 0);
    const totalRemaining = recon.rows
      .filter((row) => row.vat.state === 'active')
      .reduce((sum, row) => sum + (row.remaining ?? 0), 0);
    return {
      vatTotal: vats.filter((vat) => vat.id !== LEGACY_VAT_ID).length,
      activeCount: active.length,
      totalCapacity,
      totalRemaining,
      pendingCount: recon.pendingCoats.length,
      suspendedCount: recon.suspendedCount,
    };
  }, [vats, recon]);

  const openCreate = (): void => {
    setEditing(null);
    const draft = createEmptyVatDraft();
    const sameDay = vats.filter((vat) => vat.mixedAt === draft.mixedAt && vat.id !== LEGACY_VAT_ID).length;
    form.setFieldsValue({ ...draft, code: generateVatCode(draft.mixedAt, sameDay + 1) });
    setOpen(true);
  };

  const openEdit = (vat: Vat): void => {
    setEditing(vat);
    form.setFieldsValue({
      code: vat.code,
      paintType: vat.paintType,
      formula: vat.formula,
      capacity: vat.capacity,
      mixedAt: vat.mixedAt,
      state: vat.state,
      note: vat.note,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      await updateVat(editing.id, values);
      message.success(`已更新调漆缸 ${values.code}`);
    } else {
      await createVat(values);
      message.success(`已登记调漆缸 ${values.code}`);
    }
    setOpen(false);
  };

  const handleVoid = (vat: Vat): void => {
    modal.confirm({
      title: `将 ${vat.code} 结皮作废？`,
      content: '作废后：没涂完、领过这缸的道次退回「待涂」；涂完的道次照旧留着；调漆缸台账保留不动。',
      okText: '确认作废',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: async () => {
        const result = await voidVat(vat.id);
        message.success(`已作废 ${vat.code}，${result.returned} 道未涂完道次已退回待涂`);
      },
    });
  };

  const columns: ColumnsType<Vat> = [
    { title: '缸号', dataIndex: 'code', width: 170, render: (value: string) => <Tag color="#8c2f1f">{value}</Tag> },
    {
      title: '漆种',
      dataIndex: 'paintType',
      width: 90,
      render: (value: PaintType) => <Tag>{PAINT_TYPE_LABEL[value]}</Tag>,
    },
    { title: '配方', dataIndex: 'formula', ellipsis: true },
    { title: '调制日期', dataIndex: 'mixedAt', width: 120, sorter: (a, b) => a.mixedAt.localeCompare(b.mixedAt) },
    { title: '容量(道)', dataIndex: 'capacity', width: 90, align: 'center' },
    {
      title: '已用',
      key: 'usage',
      width: 80,
      align: 'center',
      render: (_value, record) => {
        const row = recon.rows.find((item) => item.vat.id === record.id);
        return row ? row.usage : '—';
      },
    },
    {
      title: '当下余量',
      key: 'remaining',
      width: 100,
      align: 'center',
      render: (_value, record) => {
        if (record.id === LEGACY_VAT_ID) return <Typography.Text type="secondary">历史缸</Typography.Text>;
        const row = recon.rows.find((item) => item.vat.id === record.id);
        if (!row || row.remaining === null) return '—';
        const color = row.remaining < 0 ? '#8c2f1f' : row.remaining === 0 ? '#c9963c' : '#2f6f4f';
        return <span style={{ color, fontWeight: 600 }}>{row.remaining}</span>;
      },
    },
    {
      title: '状态',
      dataIndex: 'state',
      width: 110,
      render: (value: VatState) => <Tag color={VAT_STATE_COLOR[value]}>{VAT_STATE_LABEL[value]}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          {record.state === 'active' && record.id !== LEGACY_VAT_ID ? (
            <Button size="small" type="link" danger icon={<StopOutlined />} onClick={() => handleVoid(record)}>
              结皮作废
            </Button>
          ) : null}
          {record.id !== LEGACY_VAT_ID ? (
            <Popconfirm
              title="删除该调漆缸"
              description="删除后不可恢复；已领用该缸的道次会变成孤儿道次，需重新对账。"
              okText="确认"
              cancelText="取消"
              onConfirm={() => void removeVat(record.id).then(() => message.success('已删除'))}
            >
              <Button size="small" type="link" danger icon={<DeleteOutlined />}>
                删除
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>调漆缸台账与对账</h2>
          <p>调漆间按缸登记漆种、配方与容量；髹涂组按缸领用道次并扣减余量，容量用满排队等下一缸。</p>
        </div>
        <Space wrap>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记调漆缸
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="调漆缸总数" value={stats.vatTotal} suffix="缸" tone="primary" />
        <StatBadge label="在用缸" value={stats.activeCount} suffix="缸" tone="success" />
        <StatBadge label="在缸余量" value={stats.totalRemaining} suffix="道" tone="info" />
        <StatBadge label="排队道次" value={stats.pendingCount} suffix="道" tone="warning" />
        <StatBadge label="对账挂起" value={stats.suspendedCount} suffix="项" tone="danger" />
      </div>

      {recon.suspendedCount > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`有 ${recon.suspendedCount} 项对账对不上，已挂起等人定`}
          description="超扣的调漆缸或领用了不存在缸号的道次会在此挂起，待核实后处理。"
        />
      ) : null}

      <Card
        className="gb-table-card"
        title={
          <Space>
            <ExperimentOutlined />
            <span>调漆缸台账</span>
          </Space>
        }
        styles={{ body: { padding: 0 } }}
      >
        {vats.filter((vat) => vat.id !== LEGACY_VAT_ID).length === 0 ? (
          <EmptyPanel
            title="还没有登记调漆缸"
            description="调漆间当天现调一缸漆，登记漆种、配方与容量，髹涂组即可按缸领用。"
            actionText="登记调漆缸"
            onAction={openCreate}
            size="small"
          />
        ) : (
          <Table<Vat>
            rowKey="id"
            size="small"
            pagination={false}
            columns={columns}
            dataSource={[...vats].sort((a, b) => {
              if (a.id === LEGACY_VAT_ID) return 1;
              if (b.id === LEGACY_VAT_ID) return -1;
              return b.mixedAt.localeCompare(a.mixedAt);
            })}
          />
        )}
      </Card>

      <Card title="按缸号对账" style={{ marginTop: 16 }} styles={{ body: { padding: 0 } }}>
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={recon.rows}
          columns={[
            { title: '缸号', dataIndex: ['vat', 'code'], width: 170, render: (value: string) => <Tag color="#8c2f1f">{value}</Tag> },
            { title: '漆种', dataIndex: ['vat', 'paintType'], width: 90, render: (value: PaintType) => PAINT_TYPE_LABEL[value] },
            { title: '容量(道)', dataIndex: 'capacity', width: 90, align: 'center' },
            { title: '已用(道)', dataIndex: 'usage', width: 90, align: 'center' },
            {
              title: '余量(道)',
              dataIndex: 'remaining',
              width: 90,
              align: 'center',
              render: (value: number | null) =>
                value === null ? '—' : <span style={{ color: value < 0 ? '#8c2f1f' : '#2f6f4f', fontWeight: 600 }}>{value}</span>,
            },
            { title: '领用道次', dataIndex: 'coatCount', width: 90, align: 'center' },
            {
              title: '对账状态',
              key: 'status',
              width: 120,
              render: (_value, row) =>
                row.suspended ? <Tag color="error">挂起（超扣）</Tag> : <Tag color="success">对平</Tag>,
            },
          ]}
        />
      </Card>

      {recon.orphans.length > 0 ? (
        <Card title="孤儿道次（领用了不存在的缸号）" style={{ marginTop: 16 }}>
          <Alert
            type="warning"
            showIcon
            message={`${recon.orphans.length} 道道次领用了不存在的缸号，请核实后重新指定缸号。`}
          />
        </Card>
      ) : null}

      {recon.pendingCoats.length > 0 ? (
        <Card title="排队等下一缸的道次" style={{ marginTop: 16 }}>
          <Space direction="vertical" size={6} style={{ width: '100%' }}>
            {recon.pendingCoats.map((coat) => {
              const vat = useVatStore.getState().vatById(coat.vatId);
              const shortage = vatShortage(vat, coats, coat.vatUsage);
              return (
                <Tag key={coat.id} color="warning">
                  {coat.colorName} · {coat.coatDate}
                  {shortage > 0 ? ` · 还差 ${shortage} 道` : ' · 等下一缸'}
                </Tag>
              );
            })}
          </Space>
        </Card>
      ) : null}

      <Modal
        open={open}
        title={editing ? `编辑调漆缸 ${editing.code}` : '登记调漆缸'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="code" label="缸号" rules={[{ required: true, message: '请填写缸号' }]}>
            <Input placeholder="如 VAT-20260312-01" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="paintType" label="漆种" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...PAINT_TYPE_OPTIONS]} />
            </Form.Item>
            <Form.Item name="capacity" label="容量（道）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="formula" label="配方" rules={[{ required: true, message: '请填写配方' }]}>
            <Input placeholder="如 生漆打底（漆黑）" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="mixedAt" label="调制日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="state" label="状态" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...VAT_STATE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} placeholder="可选" />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message="容量按「道」计：一缸漆够髹几道就填几。髹涂组领用后按当下余量扣减，余量不足即排队等下一缸。"
          />
        </Form>
      </Modal>
    </div>
  );
}
