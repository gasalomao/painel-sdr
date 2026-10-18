export interface DashboardTask {
  id: string;
  text: string;
  due_at: string;
  completed_at: string | null;
  lead_id: number | null;
  lead_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface DashboardTaskCounts {
  pending: number;
  overdue: number;
  dueSoon: number;
  upcoming: number;
  completed: number;
}

export interface DashboardTasksResponse {
  tasks: DashboardTask[];
  total: number;
  counts: DashboardTaskCounts;
}
