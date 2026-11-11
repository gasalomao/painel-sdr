import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import AppointmentDialog from "./AppointmentDialog";
import type { Appointment } from "../types";

afterEach(cleanup);

const appointment: Appointment = {
  id: "appointment-1",
  client_id: "tenant-1",
  agent_id: 7,
  lead_id: null,
  remote_jid: "5511999999999@s.whatsapp.net",
  instance_name: null,
  google_event_id: "google-1",
  calendar_id: "primary",
  title: "Consulta",
  description: "Atendimento inicial",
  service_name: "Consulta",
  start_at: "2026-11-10T13:00:00.000Z",
  end_at: "2026-11-10T14:00:00.000Z",
  status: "confirmed",
  created_by: "manual",
  cancelled_reason: null,
  location: "Rua Central, 100",
  attendees: [{ email: "cliente@example.com" }],
  all_day: false,
  visibility: "default",
  color_id: "5",
  html_link: "https://calendar.google.com/event?eid=google-1",
  recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
  conference_data: { hangoutLink: "https://meet.google.com/abc-defg-hij" },
  metadata: { custom_reminders: [{ offset_minutes: 30, message: "Em 30 min" }] },
};

describe("AppointmentDialog", () => {
  it("edita um agendamento existente e envia todos os campos ao Google", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        appointment: { ...appointment, title: "Consulta atualizada" },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AppointmentDialog
        open
        onOpenChange={vi.fn()}
        editing={appointment}
        agents={[{ id: 7, name: "Agente 7", is_scheduler: true, google_connected: true }]}
        onSaved={vi.fn()}
        onToast={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    expect(screen.getByRole("dialog", { name: "Editar agendamento" })).toBeInTheDocument();
    expect(screen.getByLabelText("Início")).toHaveValue("2026-11-10T10:00");
    await waitFor(() => expect(screen.getByLabelText("Título do agendamento")).toHaveFocus());
    expect(screen.getByLabelText("Repetição")).toHaveTextContent("Semanalmente");
    expect(screen.getByLabelText("Agente responsável")).toHaveTextContent("Agente 7");
    expect(screen.getByText("cliente@example.com")).toBeInTheDocument();
    expect(screen.getByText("Google Meet anexado")).toBeInTheDocument();
    expect(screen.getByText("Abrir local no Google Maps")).toBeInTheDocument();

    const title = screen.getByLabelText("Título do agendamento");
    fireEvent.change(title, { target: { value: "Consulta atualizada" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, request] = fetchMock.mock.calls[0];
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(request.body)).toMatchObject({
      title: "Consulta atualizada",
      agent_id: 7,
      recurrence: ["RRULE:FREQ=WEEKLY;COUNT=3"],
      attendees: [{ email: "cliente@example.com" }],
      create_meet: false,
      sync_google: true,
    });
  });

  it("preserva placeholder google:* ao editar evento importado", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, appointment: { ...appointment, remote_jid: "google:event-1" } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AppointmentDialog
        open
        onOpenChange={vi.fn()}
        editing={{ ...appointment, remote_jid: "google:event-1" }}
        agents={[{ id: 7, name: "Agente 7", is_scheduler: true, google_connected: true }]}
        onSaved={vi.fn()}
        onToast={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Título do agendamento")).toHaveFocus());
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [, request] = fetchMock.mock.calls[0];
    expect(request.method).toBe("PATCH");
    expect(JSON.parse(request.body)).toMatchObject({ remote_jid: "google:event-1" });
  });

  it("normaliza telefone digitado", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, appointment }),
    });
    vi.stubGlobal("fetch", fetchMock);

    render(
      <AppointmentDialog
        open
        onOpenChange={vi.fn()}
        editing={appointment}
        agents={[{ id: 7, name: "Agente 7", is_scheduler: true, google_connected: true }]}
        onSaved={vi.fn()}
        onToast={vi.fn()}
        onDelete={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Título do agendamento")).toHaveFocus());

    fireEvent.change(screen.getByLabelText("Contato do WhatsApp"), {
      target: { value: "(11) 99999-8888" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      remote_jid: "5511999998888@s.whatsapp.net",
    });
  });

  it("bloqueia contato inválido sem chamar a API", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const onToast = vi.fn();

    render(
      <AppointmentDialog
        open
        onOpenChange={vi.fn()}
        editing={appointment}
        agents={[{ id: 7, name: "Agente 7", is_scheduler: true, google_connected: true }]}
        onSaved={vi.fn()}
        onToast={onToast}
        onDelete={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.getByLabelText("Título do agendamento")).toHaveFocus());

    fireEvent.change(screen.getByLabelText("Contato do WhatsApp"), {
      target: { value: "não é telefone" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Salvar alterações" }));

    await waitFor(() => expect(onToast).toHaveBeenCalledWith({
      kind: "err",
      text: "Contato do WhatsApp inválido.",
    }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
