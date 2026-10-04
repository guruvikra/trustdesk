// Deterministic policy facts. All windows are measured from the ticket's created_at, never the
// wall clock, so seeded tickets behave the same on any day.

const { includesAny } = require('../lib/text');

const RETURN_WINDOW_DAYS = 7;
const BASE_WARRANTY_MONTHS = 12;
const GOLD_EXTENSION_MONTHS = 6;
const STALE_TRACKING_BUSINESS_DAYS = 5;
const HARDWARE_CATEGORIES = ['audio', 'tablet', 'wearable', 'camera', 'phone', 'laptop', 'electronics', 'hardware'];

function toDate(value) {
  if (!value) return null;
  // Date-only values are interpreted in IST, matching the dataset.
  const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00+05:30`) : new Date(value);
  return isNaN(d) ? null : d;
}

function monthsBetween(a, b) {
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
}

const DAMAGE_WORDS = ['damaged', 'cracked', 'broken', 'shattered', 'dented', 'defective', 'not working', 'stopped working', 'dead on arrival', 'faulty', 'failed', 'scratched'];

function computeFacts(ticket, order, customer, { customerOrderCount = null } = {}) {
  const text = `${ticket.subject || ''} ${ticket.body || ''}`;
  const created = toDate(ticket.created_at) || new Date();
  const facts = {
    evaluated_at: created.toISOString(),
    evaluated_relative_to: 'ticket.created_at',
    customer: customer ? { tier: customer.tier, verified: Boolean(customer.verified) } : { tier: 'unknown', verified: false, note: 'No matching customer record' },
    order: null,
    return_policy: null,
    warranty: null,
    shipping: null,
    signals: {
      mentions_damage: includesAny(text, DAMAGE_WORDS),
      urgent_need: includesAny(text, ['travel', 'trip', 'next week', 'urgent', 'asap', 'wedding', 'flight', 'deadline', 'tomorrow']),
      change_of_mind: includesAny(text, ['changed my mind', 'no longer need', "don't want", 'do not want', 'not needed']),
      duplicate_charge: includesAny(text, ['double charge', 'charged twice', 'two charges', 'duplicate charge', 'charged two times', 'charged 2 times', 'double charged']),
      coupon_requested: includesAny(text, ['coupon', 'voucher', 'promo code', 'discount code']),
      refund_requested: includesAny(text, ['refund', 'money back', 'reimburse']),
      replacement_requested: includesAny(text, ['replacement', 'replace', 'exchange']),
      stale_business_days_reported: null,
    },
  };

  const stale = text.match(/(\d+)\s*(business |working )?days?/i);
  if (stale && includesAny(text, ['tracking', 'not moved', 'no movement', 'stuck', 'no update'])) {
    facts.signals.stale_business_days_reported = Number(stale[1]);
  }

  if (!order) return facts;

  const items = order.items || [];
  const finalSale = items.some(i => i.final_sale || i.category === 'software');
  facts.order = {
    order_id: order.order_id, status: order.status, placed_at: order.placed_at, delivered_at: order.delivered_at,
    total: order.total, currency: order.currency, payment_status: order.payment_status, tracking_number: order.tracking_number,
    items: items.map(i => ({ sku: i.sku, name: i.name, category: i.category, final_sale: Boolean(i.final_sale) })),
    customer_order_count: customerOrderCount,
  };

  const delivered = toDate(order.delivered_at);
  if (delivered) {
    const days = Math.floor((created - delivered) / 86400000);
    facts.return_policy = {
      days_since_delivery: days,
      window_days: RETURN_WINDOW_DAYS,
      within_window: days >= 0 && days <= RETURN_WINDOW_DAYS,
      final_sale_items: finalSale,
      eligible_for_return: !finalSale && days >= 0 && days <= RETURN_WINDOW_DAYS,
    };
    const months = monthsBetween(delivered, created);
    const hardware = items.some(i => HARDWARE_CATEGORIES.includes(i.category));
    const goldEligible = customer && customer.tier === 'gold' && hardware && !finalSale &&
      !items.every(i => i.category === 'accessory' && Number(order.total) < 3000);
    const coverage = BASE_WARRANTY_MONTHS + (goldEligible ? GOLD_EXTENSION_MONTHS : 0);
    facts.warranty = {
      months_since_delivery: months,
      base_months: BASE_WARRANTY_MONTHS,
      gold_extension_months: goldEligible ? GOLD_EXTENSION_MONTHS : 0,
      coverage_months: coverage,
      within_warranty: hardware && !finalSale && months < coverage,
      applies_to_items: hardware && !finalSale,
    };
  }

  if (order.status === 'in_transit' || order.status === 'shipped' || !delivered) {
    const reported = facts.signals.stale_business_days_reported;
    facts.shipping = {
      in_transit: true,
      tracking_number: order.tracking_number,
      stale_business_days_reported: reported,
      stale_threshold_business_days: STALE_TRACKING_BUSINESS_DAYS,
      carrier_investigation_eligible: reported !== null && reported >= STALE_TRACKING_BUSINESS_DAYS,
      lost_package_resolution_eligible: reported !== null && reported >= 10,
    };
  }
  return facts;
}

module.exports = { computeFacts, toDate, RETURN_WINDOW_DAYS, DAMAGE_WORDS };
