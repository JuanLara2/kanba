export class AIService {
  constructor(supabase) {
    this.supabase = supabase;
  }

  async suggestSubtasks(title, description) {
    const { data, error } = await this.supabase.functions.invoke('generate-subtasks', {
      body: { title, description }
    });
    if (error) throw error;

    if (!Array.isArray(data?.subtasks)) {
      throw new Error('La respuesta de IA no contiene una lista de subtareas válida.');
    }

    return data.subtasks
      .filter((item) => typeof item === 'string')
      .map((item) => item.trim().slice(0, 200))
      .filter(Boolean)
      .slice(0, 10);
  }
}
