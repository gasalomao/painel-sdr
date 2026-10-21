import { render, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import CalendarGrid from "./CalendarGrid";

type CalendarProps = {
  events: { id: string; start: Date; end: Date; allDay: boolean; resource: { status: string } }[];
  onSelectSlot: (slot: unknown) => void;
  onSelectEvent: (event: unknown) => void;
  onEventDrop: (event: unknown) => void;
  onEventResize: (event: unknown) => void;
  onNavigate: (date: Date) => void;
  onView: (view: string) => void;
  draggableAccessor: (event: unknown) => boolean;
  resizableAccessor: (event: unknown) => boolean;
  selectable: boolean;
  popup: boolean;
  views: string[];
};
const captured = vi.hoisted(() => ({ props: null as CalendarProps | null }));
vi.mock("react-big-calendar", () => ({ Calendar: () => null, dateFnsLocalizer: vi.fn() }));
vi.mock("react-big-calendar/lib/addons/dragAndDrop", () => ({ default: () => (props: CalendarProps) => { captured.props = props; return <div />; } }));
afterEach(cleanup);

const appointment = {
  id: "test-appointment", client_id: "test-tenant", agent_id: 1, lead_id: null,
  remote_jid: "5511999999999@s.whatsapp.net", instance_name: null, google_event_id: null,
  title: "Reunião de teste", description: null, service_name: null,
  start_at: "2026-10-20T13:00:00.000Z", end_at: "2026-10-20T14:00:00.000Z",
  status: "confirmed" as const, created_by: "manual" as const, cancelled_reason: null,
};

describe("CalendarGrid — contrato de interações", () => {
  it.each(["month", "week", "day"] as const)("preserva eventos e callbacks na visualização %s", (view) => {
    const onNavigate = vi.fn(), onView = vi.fn(), onSelectSlot = vi.fn(), onSelectEvent = vi.fn(), onEventDropOrResize = vi.fn();
    render(<CalendarGrid appointments={[appointment]} anchor={new Date(appointment.start_at)} view={view} onNavigate={onNavigate} onView={onView} onSelectSlot={onSelectSlot} onSelectEvent={onSelectEvent} onEventDropOrResize={onEventDropOrResize} />);
    const props = captured.props!;
    const event = props.events[0];
    expect(event).toMatchObject({ id: appointment.id, resource: appointment, allDay: false });
    expect(event.start.toISOString()).toBe(appointment.start_at);
    expect(props.views).toEqual(["month", "week", "day"]);
    expect(props.selectable).toBe(true);
    expect(props.popup).toBe(true);
    const slot = { start: event.start, end: event.end };
    props.onSelectSlot(slot);
    props.onSelectEvent(event);
    props.onNavigate(event.start);
    props.onView("week");
    const movement = { event, ...slot };
    props.onEventDrop(movement);
    props.onEventResize(movement);
    expect(onSelectSlot).toHaveBeenCalledWith(slot);
    expect(onSelectEvent).toHaveBeenCalledWith(event);
    expect(onNavigate).toHaveBeenCalledWith(event.start);
    expect(onView).toHaveBeenCalledWith("week");
    expect(onEventDropOrResize).toHaveBeenNthCalledWith(1, movement);
    expect(onEventDropOrResize).toHaveBeenNthCalledWith(2, movement);
    expect(props.draggableAccessor(event)).toBe(true);
    expect(props.resizableAccessor(event)).toBe(true);
    const cancelled = { resource: { status: "cancelled" } };
    expect(props.draggableAccessor(cancelled)).toBe(false);
    expect(props.resizableAccessor(cancelled)).toBe(false);
  });
});
