/**
 * <VatDrawModal> 髹涂组领用弹窗
 * 为待涂道次选择同漆种的在用缸并登记用掉几道；余量不足时提示差额，
 * 确认后道次排队等下一缸。被道次页（/coats）与调漆间页（/vats）共用。
 */
import { useEffect, useMemo, useState } from 'react';
import { Alert, Form, InputNumber, Modal, Select, Space, Typography } from 'antd';
import { useCoatStore } from '@/stores/coatStore';
import { useVatStore, type DrawResult } from '@/stores/vatStore';
import { PAINT_TYPE_LABEL, type Coat } from '@/types/coat';
import { buildVatBook, type Vat } from '@/types/vat';

export interface VatDrawModalProps {
  open: boolean;
  /** 目标道次；为 null 时不渲染内容 */
  coat: Coat | null;
  onClose: () => void;
  /** 领用（或排队）完成后的回调，由调用方发提示 */
  onDone: (result: DrawResult) => void;
}

interface DrawFormValues {
  vatId?: string;
  drawCoats: number;
}

export function VatDrawModal({ open, coat, onClose, onDone }: VatDrawModalProps) {
  const [form] = Form.useForm<DrawFormValues>();
  const vats = useVatStore((state) => state.vats);
  const coats = useCoatStore((state) => state.coats);
  const drawForCoat = useVatStore((state) => state.drawForCoat);
  const queueCoat = useVatStore((state) => state.queueCoat);
  const [submitting, setSubmitting] = useState(false);

  // 同漆种的在用缸才是候选
  const candidates = useMemo(
    () => (coat ? vats.filter((vat) => vat.paintType === coat.paintType && vat.state === 'inUse') : []),
    [coat, vats],
  );

  const remainingOf = (vat: Vat): number => buildVatBook(vat, coats).remainingCoats;

  useEffect(() => {
    if (!open || !coat) return;
    const firstAvailable = candidates.find((vat) => remainingOf(vat) > 0) ?? candidates[0];
    form.setFieldsValue({
      vatId: firstAvailable?.id,
      drawCoats: coat.awaitVat && coat.shortageCoats > 0 ? coat.shortageCoats : (coat.drawCoats || 1),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, coat, candidates, form]);

  const watchedVatId = Form.useWatch('vatId', form);
  const watchedDrawCoats = Form.useWatch('drawCoats', form) ?? 1;
  const selectedVat = candidates.find((vat) => vat.id === watchedVatId) ?? null;
  const selectedRemaining = selectedVat ? remainingOf(selectedVat) : 0;
  const shortage = selectedVat ? Math.max(0, watchedDrawCoats - selectedRemaining) : watchedDrawCoats;
  const willQueue = !selectedVat || shortage > 0;

  const submit = async (): Promise<void> => {
    if (!coat) return;
    const values = await form.validateFields();
    setSubmitting(true);
    try {
      let result: DrawResult;
      if (!values.vatId) {
        // 无缸可领：直接排队等下一缸
        await queueCoat(coat.id, values.drawCoats);
        result = { kind: 'queued', vatNo: '', shortage: values.drawCoats };
      } else {
        result = await drawForCoat(coat.id, values.vatId, values.drawCoats);
      }
      onDone(result);
      if (result.kind !== 'error') onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={coat ? `领用漆缸 · 第 ${coat.seq} 道（${PAINT_TYPE_LABEL[coat.paintType]} · ${coat.colorName}）` : '领用漆缸'}
      onCancel={onClose}
      onOk={() => void submit()}
      okText={willQueue ? '余量不足，排队等下一缸' : '确认领用'}
      cancelText="取消"
      confirmLoading={submitting}
      destroyOnClose
    >
      {coat ? (
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item
            name="vatId"
            label="领用哪缸（仅列同漆种在用缸）"
            rules={candidates.length > 0 ? [{ required: true, message: '请选择调漆缸' }] : []}
          >
            <Select
              placeholder={candidates.length > 0 ? '选择调漆缸' : '暂无在用缸，请先到调漆间登记'}
              options={candidates.map((vat) => ({
                value: vat.id,
                label: `${vat.vatNo} · 余 ${remainingOf(vat)} / ${vat.capacityCoats} 道`,
                disabled: remainingOf(vat) <= 0,
              }))}
            />
          </Form.Item>
          <Form.Item name="drawCoats" label="用掉几道" rules={[{ required: true, message: '请填写道数' }]}>
            <InputNumber min={1} max={99} style={{ width: '100%' }} />
          </Form.Item>
          {selectedVat && shortage > 0 ? (
            <Alert
              type="warning"
              showIcon
              message={`缸 ${selectedVat.vatNo} 余量 ${selectedRemaining} 道，不够 ${watchedDrawCoats} 道`}
              description={`确认后该道次排队等下一缸，还差 ${shortage} 道。`}
            />
          ) : null}
          {!selectedVat ? (
            <Alert
              type="warning"
              showIcon
              message="当前没有可领的在用缸"
              description={`确认后该道次排队等下一缸，还差 ${watchedDrawCoats} 道；可到调漆间登记新缸后再领。`}
            />
          ) : null}
          {selectedVat && shortage === 0 ? (
            <Space size={4}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                领用后 {selectedVat.vatNo} 余量剩 {selectedRemaining - watchedDrawCoats} 道；用满自动结缸。
              </Typography.Text>
            </Space>
          ) : null}
        </Form>
      ) : null}
    </Modal>
  );
}

export default VatDrawModal;
