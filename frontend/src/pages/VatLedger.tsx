/**
 * /vats 调漆间台账
 * 调漆间按缸登记漆种、配方与容量；髹涂组领用按缸里当下余量扣减，
 * 容量用满排队等下一缸；缸结皮作废后未涂道次退回待涂、涂完的照旧、台账不动；
 * 两边按缸号对账，对不上的挂起等人定。
 * 消费 Vat、ReconItem、Coat、Body；复用 <StatBadge>、<EmptyPanel>、<VatDrawModal>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  Col,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Progress,
  Row,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
  AuditOutlined,
  CheckOutlined,
  FireOutlined,
  GoldOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import VatDrawModal from '@/components/common/VatDrawModal';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { useVatStore, type DrawResult } from '@/stores/vatStore';
import { PAINT_TYPE_LABEL, PAINT_TYPE_OPTIONS, type Coat } from '@/types/coat';
import {
  HIST_VAT_ID,
  VAT_STATE_COLOR,
  VAT_STATE_LABEL,
  buildVatBook,
  createEmptyVatDraft,
  type Vat,
  type VatDraft,
} from '@/types/vat';
import { RECON_STATE_COLOR, RECON_STATE_LABEL, type ReconItem } from '@/types/recon';

export default function VatLedger() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<VatDraft>();
  const [resolveForm] = Form.useForm<{ resolvedBy: string; resolveNote: string }>();

  const vats = useVatStore((state) => state.vats);
  const recons = useVatStore((state) => state.recons);
  const createVat = useVatStore((state) => state.createVat);
  const scrapVat = useVatStore((state) => state.scrapVat);
  const runRecon = useVatStore((state) => state.runRecon);
  const resolveRecon = useVatStore((state) => state.resolveRecon);
  const coats = useCoatStore((state) => state.coats);
  const bodies = useBodyStore((state) => state.bodies);

  const [open, setOpen] = useState(false);
  const [reconning, setReconning] = useState(false);
  const [resolving, setResolving] = useState<ReconItem | null>(null);
  const [drawCoat, setDrawCoat] = useState<Coat | null>(null);

  /** 缸号 → 当下账本（容量 / 已领 / 退回 / 余量） */
  const books = useMemo(() => {
    const map = new Map<string, ReturnType<typeof buildVatBook>>();
    vats.forEach((vat) => map.set(vat.id, buildVatBook(vat, coats)));
    return map;
  }, [vats, coats]);

  const waitingCoats = useMemo(
    () => coats.filter((coat) => coat.awaitVat && coat.state === 'todo').sort((a, b) => a.updatedAt - b.updatedAt),
    [coats],
  );
  const pendingRecons = useMemo(() => recons.filter((item) => item.state === 'pending'), [recons]);
  const resolvedRecons = useMemo(() => recons.filter((item) => item.state === 'resolved'), [recons]);
  const remainingTotal = useMemo(
    () =>
      vats
        .filter((vat) => vat.state === 'inUse')
        .reduce((sum, vat) => sum + Math.max(0, books.get(vat.id)?.remainingCoats ?? 0), 0),
    [vats, books],
  );

  const bodyCode = (bodyId: string): string => bodies.find((body) => body.id === bodyId)?.code ?? bodyId;

  const openCreate = (): void => {
    form.setFieldsValue(createEmptyVatDraft(vats));
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    const row = await createVat({ ...values, state: 'inUse' });
    setOpen(false);
    const waiting = coats.filter((coat) => coat.awaitVat && coat.state === 'todo' && coat.paintType === row.paintType);
    message.success(
      waiting.length > 0
        ? `已登记 ${row.vatNo}（${PAINT_TYPE_LABEL[row.paintType]}）；有 ${waiting.length} 道同漆种道次在等漆，可前往领用`
        : `已登记 ${row.vatNo}（${PAINT_TYPE_LABEL[row.paintType]} · 容量 ${row.capacityCoats} 道）`,
    );
  };

  const handleScrap = async (vat: Vat): Promise<void> => {
    const returned = await scrapVat(vat.id);
    message.success(
      returned > 0
        ? `缸 ${vat.vatNo} 已作废，${returned} 道未涂道次退回待涂；涂完的照旧保留，调漆间台账不动`
        : `缸 ${vat.vatNo} 已作废，无未涂道次需要退回`,
    );
  };

  const handleRecon = async (): Promise<void> => {
    setReconning(true);
    try {
      const created = await runRecon();
      if (created > 0) message.warning(`对账完成：${created} 缸对不上，已挂起等人定`);
      else message.success('对账完成：各缸账目对平');
    } finally {
      setReconning(false);
    }
  };

  const submitResolve = async (): Promise<void> => {
    if (!resolving) return;
    const values = await resolveForm.validateFields();
    await resolveRecon(resolving.id, values.resolvedBy, values.resolveNote);
    message.success(`挂起单已核销（${values.resolvedBy}）`);
    setResolving(null);
  };

  const handleDrawDone = (result: DrawResult): void => {
    if (result.kind === 'ok') message.success(`已领用 ${result.vatNo}，按缸里当下余量扣减`);
    else if (result.kind === 'queued')
      message.warning(
        result.vatNo ? `缸 ${result.vatNo} 余量不足，已排队等下一缸，还差 ${result.shortage} 道` : `暂无在用缸，已排队等下一缸，还差 ${result.shortage} 道`,
      );
    else message.error(result.message);
  };

  const vatColumns: ColumnsType<Vat> = [
    {
      title: '缸号',
      dataIndex: 'vatNo',
      width: 110,
      render: (value: string, record) => (
        <Tag color={record.id === HIST_VAT_ID ? '#c9963c' : '#8c2f1f'}>{value}</Tag>
      ),
    },
    {
      title: '漆种',
      dataIndex: 'paintType',
      width: 90,
      render: (value: Vat['paintType']) => PAINT_TYPE_LABEL[value],
    },
    { title: '配方', dataIndex: 'formula', ellipsis: true, render: (value: string) => value || '—' },
    { title: '调漆日期', dataIndex: 'mixedDate', width: 110, sorter: (a, b) => a.mixedDate.localeCompare(b.mixedDate) },
    { title: '容量', dataIndex: 'capacityCoats', width: 80, render: (value: number) => `${value} 道` },
    {
      title: '已领 / 退回',
      key: 'drawn',
      width: 110,
      render: (_value, record) => {
        const book = books.get(record.id);
        if (!book) return '—';
        return (
          <Space size={4}>
            <span>{book.drawnCoats} 道</span>
            {book.returnedCoats > 0 ? <Typography.Text type="danger">退 {book.returnedCoats}</Typography.Text> : null}
          </Space>
        );
      },
    },
    {
      title: '当下余量',
      key: 'remaining',
      width: 150,
      render: (_value, record) => {
        const book = books.get(record.id);
        if (!book || record.capacityCoats <= 0) return <Typography.Text type="secondary">—</Typography.Text>;
        const remaining = Math.max(0, book.remainingCoats);
        return (
          <Space size={6} style={{ width: '100%' }}>
            <Progress
              percent={Math.round((remaining / record.capacityCoats) * 100)}
              size="small"
              showInfo={false}
              strokeColor={remaining > 0 ? '#2f6f4f' : '#b03a2e'}
              style={{ width: 60, margin: 0 }}
            />
            <Typography.Text type={remaining > 0 ? undefined : 'danger'}>余 {remaining} 道</Typography.Text>
          </Space>
        );
      },
    },
    {
      title: '状态',
      dataIndex: 'state',
      width: 90,
      render: (value: Vat['state']) => <Tag color={VAT_STATE_COLOR[value]}>{VAT_STATE_LABEL[value]}</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 110,
      render: (_value, record) =>
        record.state === 'inUse' ? (
          <Popconfirm
            title={`结皮作废 ${record.vatNo}`}
            description="未涂道次退回待涂，涂完的照旧留着，调漆间台账不动。"
            okText="确认作废"
            cancelText="取消"
            onConfirm={() => void handleScrap(record)}
          >
            <Button size="small" type="link" danger icon={<FireOutlined />}>
              结皮作废
            </Button>
          </Popconfirm>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
  ];

  const waitingColumns: ColumnsType<Coat> = [
    { title: '胎体', dataIndex: 'bodyId', width: 100, render: (value: string) => bodyCode(value) },
    { title: '道次', dataIndex: 'seq', width: 80, render: (value: number) => `第 ${value} 道` },
    {
      title: '漆种',
      dataIndex: 'paintType',
      width: 90,
      render: (value: Coat['paintType']) => PAINT_TYPE_LABEL[value],
    },
    { title: '色名', dataIndex: 'colorName', width: 110 },
    {
      title: '还差',
      dataIndex: 'shortageCoats',
      width: 90,
      render: (value: number) => <Tag color="#c9963c">还差 {value} 道</Tag>,
    },
    {
      title: '操作',
      key: 'action',
      width: 90,
      render: (_value, record) => (
        <Button size="small" type="link" icon={<GoldOutlined />} onClick={() => setDrawCoat(record)}>
          领用
        </Button>
      ),
    },
  ];

  const reconColumns: ColumnsType<ReconItem> = [
    { title: '缸号', dataIndex: 'vatNo', width: 100, render: (value: string) => <Tag color="#8c2f1f">{value}</Tag> },
    { title: '容量(调漆间账)', dataIndex: 'capacityCoats', width: 120, render: (value: number) => `${value} 道` },
    { title: '领用(髹涂组账)', dataIndex: 'drawnCoats', width: 120, render: (value: number) => `${value} 道` },
    {
      title: '退回',
      dataIndex: 'returnedCoats',
      width: 80,
      render: (value: number) => (value > 0 ? `退 ${value}` : '—'),
    },
    { title: '对不上的原因', dataIndex: 'reason', ellipsis: true },
    {
      title: '挂起时间',
      dataIndex: 'createdAt',
      width: 150,
      render: (value: number) => new Date(value).toLocaleString('zh-CN'),
    },
    {
      title: '操作',
      key: 'action',
      width: 100,
      render: (_value, record) => (
        <Button
          size="small"
          type="link"
          icon={<CheckOutlined />}
          onClick={() => {
            resolveForm.setFieldsValue({ resolvedBy: '', resolveNote: '' });
            setResolving(record);
          }}
        >
          核销
        </Button>
      ),
    },
  ];

  const resolvedColumns: ColumnsType<ReconItem> = [
    { title: '缸号', dataIndex: 'vatNo', width: 100, render: (value: string) => <Tag>{value}</Tag> },
    { title: '挂起原因', dataIndex: 'reason', ellipsis: true },
    { title: '核销人', dataIndex: 'resolvedBy', width: 100 },
    {
      title: '核销时间',
      dataIndex: 'resolvedAt',
      width: 150,
      render: (value: string | null) => (value ? new Date(value).toLocaleString('zh-CN') : '—'),
    },
    { title: '人定结论', dataIndex: 'resolveNote', ellipsis: true, render: (value: string) => value || '—' },
  ];

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>调漆间台账</h2>
          <p>当天现调按缸登记漆种、配方与容量；髹涂组领用按缸扣减，容量用满排队等下一缸；两边按缸号对账。</p>
        </div>
        <Space wrap>
          <Button icon={<AuditOutlined />} loading={reconning} onClick={() => void handleRecon()}>
            发起对账
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            登记新缸
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="在册漆缸" value={vats.length} suffix="缸" tone="primary" />
        <StatBadge label="在用余量合计" value={remainingTotal} suffix="道" tone="success" />
        <StatBadge label="等漆道次" value={waitingCoats.length} suffix="道" tone="warning" />
        <StatBadge label="挂起待核" value={pendingRecons.length} suffix="单" tone="danger" />
      </div>

      <Card className="gb-table-card" title="调漆缸台账" styles={{ body: { padding: 0 } }}>
        {vats.length === 0 ? (
          <EmptyPanel
            title="调漆间还没有登记漆缸"
            description="当天现调的漆按缸登记漆种、配方与容量，髹涂组才能领用。"
            actionText="登记新缸"
            onAction={openCreate}
            size="small"
          />
        ) : (
          <Table<Vat> rowKey="id" size="small" pagination={false} columns={vatColumns} dataSource={vats} />
        )}
      </Card>

      <Row gutter={16} style={{ marginTop: 16 }}>
        <Col xs={24} xl={10}>
          <Card
            title="等漆队列"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                容量用满排队等下一缸
              </Typography.Text>
            }
            styles={{ body: { padding: 0 } }}
          >
            {waitingCoats.length === 0 ? (
              <EmptyPanel
                title="没有道次在等漆"
                description="领用时缸里余量不足的道次会排在这里，并写明还差几道。"
                size="small"
              />
            ) : (
              <Table<Coat>
                rowKey="id"
                size="small"
                pagination={false}
                columns={waitingColumns}
                dataSource={waitingCoats}
              />
            )}
          </Card>
        </Col>
        <Col xs={24} xl={14}>
          <Card
            title="按缸号对账"
            extra={
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                调漆间账（容量）对髹涂组账（领用），对不上先挂起等人定
              </Typography.Text>
            }
            styles={{ body: { padding: 0 } }}
          >
            <Tabs
              style={{ paddingInline: 16 }}
              items={[
                {
                  key: 'pending',
                  label: (
                    <span>
                      挂起待核 <Tag color={RECON_STATE_COLOR.pending}>{pendingRecons.length}</Tag>
                    </span>
                  ),
                  children:
                    pendingRecons.length === 0 ? (
                      <EmptyPanel
                        title="没有挂起的对账单"
                        description="点右上角「发起对账」核一遍缸号；对不上的会挂在这里等人定。"
                        size="small"
                      />
                    ) : (
                      <Table<ReconItem>
                        rowKey="id"
                        size="small"
                        pagination={false}
                        columns={reconColumns}
                        dataSource={pendingRecons}
                      />
                    ),
                },
                {
                  key: 'resolved',
                  label: (
                    <span>
                      已核销 <Tag color={RECON_STATE_COLOR.resolved}>{resolvedRecons.length}</Tag>
                    </span>
                  ),
                  children:
                    resolvedRecons.length === 0 ? (
                      <EmptyPanel title="还没有核销记录" description="挂起单经人工定夺核销后留档在这里。" size="small" />
                    ) : (
                      <Table<ReconItem>
                        rowKey="id"
                        size="small"
                        pagination={{ pageSize: 5 }}
                        columns={resolvedColumns}
                        dataSource={resolvedRecons}
                      />
                    ),
                },
              ]}
            />
            <div style={{ padding: '0 16px 12px' }}>
              <Alert
                type="info"
                showIcon
                message={`对账口径：${RECON_STATE_LABEL.pending}单在核销前不会重复挂；缸结皮作废只改状态，调漆间这本账不动。`}
              />
            </div>
          </Card>
        </Col>
      </Row>

      <Modal
        open={open}
        title="登记调漆缸"
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="登记"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="vatNo"
              label="缸号"
              rules={[
                { required: true, message: '请填写缸号' },
                {
                  validator: (_rule, value: string) =>
                    vats.some((vat) => vat.vatNo === value) ? Promise.reject(new Error('缸号已存在')) : Promise.resolve(),
                },
              ]}
              style={{ flex: 1 }}
            >
              <Input placeholder="如：G-2606" />
            </Form.Item>
            <Form.Item name="paintType" label="漆种" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...PAINT_TYPE_OPTIONS]} />
            </Form.Item>
          </Space>
          <Form.Item name="formula" label="配方" rules={[{ required: true, message: '请填写配方' }]}>
            <Input placeholder="如：朱砂粉调生漆 1:2" />
          </Form.Item>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="capacityCoats" label="容量（可髹道数）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={99} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="mixedDate" label="调漆日期" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
          </Space>
          <Form.Item name="note" label="备注">
            <Input placeholder="可空" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={resolving !== null}
        title={resolving ? `核销挂起单 · ${resolving.vatNo}` : '核销挂起单'}
        onCancel={() => setResolving(null)}
        onOk={() => void submitResolve()}
        okText="核销"
        cancelText="取消"
        destroyOnClose
      >
        {resolving ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message={resolving.reason}
            description={`调漆间账容量 ${resolving.capacityCoats} 道 · 髹涂组账领用 ${resolving.drawnCoats} 道 · 退回 ${resolving.returnedCoats} 道`}
          />
        ) : null}
        <Form form={resolveForm} layout="vertical" preserve={false}>
          <Form.Item name="resolvedBy" label="核销人（人定）" rules={[{ required: true, message: '请填写核销人' }]}>
            <Input placeholder="如：周衡" />
          </Form.Item>
          <Form.Item name="resolveNote" label="人定结论" rules={[{ required: true, message: '请填写核销说明' }]}>
            <Input.TextArea rows={3} placeholder="如：旧账道次确属此缸，容量记错，按领用数核销" />
          </Form.Item>
        </Form>
      </Modal>

      <VatDrawModal open={drawCoat !== null} coat={drawCoat} onClose={() => setDrawCoat(null)} onDone={handleDrawDone} />
    </div>
  );
}
