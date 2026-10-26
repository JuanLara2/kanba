import { SLA_THRESHOLDS_HOURS } from '../config/constants.js';

export class FilterSortService {
  static apply(tickets, criteria, usersMap) {
    const {
      search = '',
      assignedTo = 'ALL',
      status = 'ALL',
      priority = 'ALL',
      dueFilter = 'ALL',
      sortField = 'createdAt',
      sortDirection = 'desc'
    } = criteria;

    const query = search.trim().toLowerCase();
    const now = Date.now();

    return tickets
      .filter((ticket) => {
        if (query) {
          const user = usersMap.get(ticket.assignedTo);
          const userName = user ? user.fullName.toLowerCase() : '';
          const matchTitle = ticket.title.toLowerCase().includes(query);
          const matchDesc = ticket.description.toLowerCase().includes(query);
          const matchId = ticket.id.toLowerCase().includes(query);
          const matchAssignee = userName.includes(query);

          if (!matchTitle && !matchDesc && !matchId && !matchAssignee) {
            return false;
          }
        }

        if (status !== 'ALL' && ticket.status !== status) return false;
        if (assignedTo !== 'ALL' && ticket.assignedTo !== assignedTo) return false;
        if (priority !== 'ALL' && ticket.priority !== priority) return false;

        if (dueFilter !== 'ALL') {
          if (!ticket.dueDate) return false;
          const dueAt = new Date(ticket.dueDate).getTime();
          if (!Number.isFinite(dueAt)) return false;
          const diffHours = (dueAt - now) / (1000 * 60 * 60);

          if (dueFilter === 'overdue' && diffHours >= SLA_THRESHOLDS_HOURS.OVERDUE) return false;
          if (dueFilter === 'warning'
            && (diffHours < SLA_THRESHOLDS_HOURS.OVERDUE || diffHours > SLA_THRESHOLDS_HOURS.WARNING)) return false;
          if (dueFilter === 'future' && diffHours <= SLA_THRESHOLDS_HOURS.WARNING) return false;
        }

        return true;
      })
      .sort((a, b) => {
        let valA = a[sortField];
        let valB = b[sortField];

        if (sortField === 'createdAt' || sortField === 'updatedAt' || sortField === 'dueDate') {
          valA = valA ? new Date(valA).getTime() : 0;
          valB = valB ? new Date(valB).getTime() : 0;
        }

        if (valA < valB) return sortDirection === 'asc' ? -1 : 1;
        if (valA > valB) return sortDirection === 'asc' ? 1 : -1;
        return 0;
      });
  }
}
