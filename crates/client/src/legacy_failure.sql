CREATE INDEX IF NOT EXISTS recovery_operation_item ON recovery(library,snippet);

CREATE TRIGGER legacy_failure_capture AFTER DELETE ON outbox BEGIN
    DELETE FROM meta WHERE key='legacy_failure_recovery';
    INSERT INTO meta(key,value)
        SELECT 'legacy_failure_recovery', ids FROM (
            WITH operation AS MATERIALIZED (
                SELECT OLD.operation->>'$.kind' AS kind, coalesce(OLD.operation->>'$.library','') AS library,
                    OLD.operation->'$.body.action' AS action,
                    CASE
                        WHEN OLD.operation->>'$.kind'='batch' THEN '$.body.items'
                        WHEN json_type(OLD.operation,'$.body.changes')='array' THEN '$.body.changes'
                        WHEN json_type(OLD.operation,'$.body.snippets')='array' THEN '$.body.snippets'
                    END AS items_path
                WHERE EXISTS(SELECT 1 FROM recovery WHERE library=coalesce(OLD.operation->>'$.library',''))
            ), records AS MATERIALIZED (
                -- The older client uses the first saved record for each item.
                SELECT record.value->>'$.id' AS id, record.value AS data, min(record.key)
                FROM operation, json_each(OLD.operation,'$.records') record WHERE operation.kind='batch'
                GROUP BY id
            ), items AS MATERIALIZED (
                SELECT operation.library, item.value->>'$.id' AS snippet,
                    CASE WHEN operation.kind='batch' THEN json_object(
                        'action', json(operation.action),
                        'item', json(item.value),
                        'record', json(records.data)
                    ) ELSE item.value END AS data
                FROM operation, json_each(OLD.operation,operation.items_path) item
                LEFT JOIN records ON records.id=item.value->>'$.id'
                WHERE operation.kind NOT IN ('merge_local','merge_synced','personal')
                    AND (operation.kind<>'batch' OR NOT EXISTS(
                        SELECT 1 FROM snippets WHERE id=item.value->>'$.id' AND data->>'$.state'='purged'
                    ))
                UNION ALL
                SELECT library,NULL,OLD.operation FROM operation
                    WHERE items_path IS NULL AND kind NOT IN ('merge_local','merge_synced','personal')
            )
            SELECT json_group_array(DISTINCT recovered.id) AS ids
            FROM items JOIN recovery recovered
                ON recovered.library=items.library AND recovered.snippet IS items.snippet AND recovered.data=items.data
            HAVING count(*)>0
        );
END;

-- The legacy UPSERT can skip its UPDATE when the decoded error has not changed.
-- Intercept the insert attempt and keep the string readable to the old CLI.
CREATE TRIGGER legacy_failure_write BEFORE INSERT ON meta
WHEN NEW.key='last_failure' AND substr(NEW.value,-1)='"' AND json_type(NEW.value)='text'
BEGIN
    -- The old sync writer deletes one queued row immediately before setting a failure.
    INSERT INTO meta(key,value)
        SELECT 'last_failure_link', json_object('stored_message', NEW.value||' ', 'recovery_ids', json(value))
        FROM meta WHERE key='legacy_failure_recovery' AND changes()=1 AND json_extract(NEW.value,'$')<>''
        ON CONFLICT(key) DO UPDATE SET value=excluded.value;
    DELETE FROM meta WHERE key='last_failure_link' AND changes()=0;
    DELETE FROM meta WHERE key='legacy_failure_recovery';
    INSERT INTO meta(key,value) VALUES('last_failure',NEW.value||' ')
        ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE value<>excluded.value;
    SELECT RAISE(IGNORE);
END;
