export function buildPendingDeliveriesQuery(selectColumns: string, bindingFilter: string): string {
  return `WITH per_invocation AS MATERIALIZED (
           SELECT i.id AS invocation_id,
                  COALESCE(delivery.sequence, 0) AS delivery_sequence,
                  CASE
                    WHEN ? IS NOT NULL AND i.workspace_binding_id IS NULL
                      AND i.status IN ('succeeded', 'failed', 'cancelled')
                      THEN (
                        SELECT MAX(latest.sequence)
                        FROM invocation_events latest
                        WHERE latest.invocation_id = i.id
                      )
                    WHEN ? IS NOT NULL AND i.workspace_binding_id IS NULL
                      THEN COALESCE(
                        (
                          SELECT MAX(lifecycle.sequence)
                          FROM invocation_events lifecycle
                          WHERE lifecycle.invocation_id = i.id
                            AND lifecycle.kind = 'daemon.task.lifecycle'
                        ),
                        (
                          SELECT MAX(latest.sequence)
                          FROM invocation_events latest
                          WHERE latest.invocation_id = i.id
                        )
                      )
                    ELSE (
                      SELECT MIN(candidate.sequence)
                      FROM invocation_events candidate
                      WHERE candidate.invocation_id = i.id
                        AND candidate.sequence > COALESCE(delivery.sequence, 0)
                    )
                  END AS next_sequence
           FROM invocations i
           LEFT JOIN invocation_event_deliveries delivery
             ON delivery.destination = ? AND delivery.invocation_id = i.id
           WHERE 1 = 1${bindingFilter}
         ),
         ordered_events AS MATERIALIZED (
           SELECT p.invocation_id AS selected_invocation_id,
                  next_event.invocation_id AS event_invocation_id,
                  next_event.sequence AS event_sequence,
                  next_event.kind AS event_kind,
                  next_event.payload_json AS event_payload_json,
                  next_event.created_at AS event_created_at
           FROM per_invocation p
           JOIN invocation_events next_event
             ON next_event.invocation_id = p.invocation_id
            AND next_event.sequence = p.next_sequence
           WHERE p.next_sequence > p.delivery_sequence
           ORDER BY next_event.created_at, next_event.invocation_id, next_event.sequence
           LIMIT ?
         )
         SELECT ${selectColumns},
                ordered_event.event_invocation_id,
                ordered_event.event_sequence,
                ordered_event.event_kind,
                ordered_event.event_payload_json,
                ordered_event.event_created_at
         FROM ordered_events ordered_event
         JOIN invocations i ON i.id = ordered_event.selected_invocation_id
         ORDER BY ordered_event.event_created_at,
                  ordered_event.event_invocation_id,
                  ordered_event.event_sequence`;
}
