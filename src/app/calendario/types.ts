export type AppointmentStatus =
  | "confirmed"
  | "tentative"
  | "cancelled"
  | "completed"
  | "no_show";

export type AppointmentVisibility = "default" | "public" | "private" | "confidential";

export type AppointmentAttendee = {
  email: string;
  displayName?: string;
  responseStatus?: string;
};

export type GoogleConferenceData = {
  entryPoints?: Array<{ entryPointType?: string; uri?: string; label?: string }>;
  conferenceSolution?: { key?: { type?: string }; name?: string };
  conferenceId?: string;
  createRequest?: {
    requestId?: string;
    conferenceSolutionKey?: { type?: string };
    status?: { statusCode?: string };
  };
  hangoutLink?: string;
};

export type Appointment = {
  id: string;
  client_id: string;
  agent_id: number | null;
  lead_id: number | null;
  remote_jid: string;
  instance_name: string | null;
  google_event_id: string | null;
  calendar_id?: string | null;
  title: string;
  description: string | null;
  service_name: string | null;
  start_at: string;
  end_at: string;
  status: AppointmentStatus;
  created_by: "ia" | "manual" | "google_sync";
  cancelled_reason: string | null;
  location?: string | null;
  attendees?: AppointmentAttendee[] | null;
  all_day?: boolean;
  visibility?: AppointmentVisibility;
  color_id?: string | null;
  html_link?: string | null;
  recurrence?: string[] | null;
  conference_data?: GoogleConferenceData | null;
  organizer_email?: string | null;
  metadata?: Record<string, unknown> | null;
  google_error?: string | null;
};

export type Agent = {
  id: number;
  name: string;
  is_scheduler: boolean;
  google_connected?: boolean;
  google_email?: string | null;
};
