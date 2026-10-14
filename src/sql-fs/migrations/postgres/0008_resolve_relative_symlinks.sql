-- Resolve relative link targets from their containing directory and cap total hops.
CREATE OR REPLACE FUNCTION fs_resolve_internal(
    p_path TEXT,
    p_follow_last BOOLEAN,
    p_depth INT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
    v_sandbox_id TEXT;
    v_root_inode BIGINT;
    v_stack BIGINT[];
    v_current BIGINT;
    v_components TEXT[];
    v_component TEXT;
    v_next BIGINT;
    v_kind SMALLINT;
    v_symlink_target TEXT;
    v_is_last BOOLEAN;
    v_hops INT := p_depth;
BEGIN
    IF v_hops > 40 THEN
        RAISE SQLSTATE 'FS001' USING MESSAGE = 'ELOOP: too many levels of symbolic links';
    END IF;
    v_sandbox_id := current_setting('app.sandbox_id');
    SELECT root_inode INTO v_root_inode FROM sandboxes WHERE id = v_sandbox_id;
    IF v_root_inode IS NULL THEN
        RAISE SQLSTATE 'FS002' USING MESSAGE = 'ENOENT: sandbox root not found';
    END IF;
    v_current := v_root_inode;
    v_stack := ARRAY[v_root_inode];
    v_components := ARRAY(
        SELECT seg FROM unnest(string_to_array(p_path, '/')) AS seg WHERE seg <> ''
    );
    WHILE cardinality(v_components) > 0 LOOP
        v_component := v_components[1];
        v_components := v_components[2:cardinality(v_components)];
        v_is_last := cardinality(v_components) = 0;
        IF v_component = '.' THEN
            CONTINUE;
        END IF;
        IF v_component = '..' THEN
            IF cardinality(v_stack) > 1 THEN
                v_stack := v_stack[1:cardinality(v_stack) - 1];
                v_current := v_stack[cardinality(v_stack)];
            END IF;
            CONTINUE;
        END IF;
        SELECT kind INTO v_kind FROM inodes WHERE id = v_current;
        IF v_kind <> 2 THEN
            RAISE SQLSTATE 'FS003' USING MESSAGE = 'ENOTDIR: not a directory';
        END IF;
        SELECT inode_id INTO v_next FROM dirents
        WHERE parent_inode_id = v_current AND name = v_component;
        IF NOT FOUND THEN
            RAISE SQLSTATE 'FS002' USING MESSAGE = 'ENOENT: no such file or directory';
        END IF;
        SELECT kind, symlink_target INTO v_kind, v_symlink_target FROM inodes WHERE id = v_next;
        IF v_kind = 3 AND (NOT v_is_last OR p_follow_last) THEN
            v_hops := v_hops + 1;
            IF v_hops > 40 THEN
                RAISE SQLSTATE 'FS001' USING MESSAGE = 'ELOOP: too many levels of symbolic links';
            END IF;
            IF left(v_symlink_target, 1) = '/' THEN
                v_current := v_root_inode;
                v_stack := ARRAY[v_root_inode];
            END IF;
            v_components := ARRAY(
                SELECT seg FROM unnest(string_to_array(v_symlink_target, '/')) AS seg WHERE seg <> ''
            ) || v_components;
            CONTINUE;
        END IF;
        v_current := v_next;
        v_stack := array_append(v_stack, v_current);
    END LOOP;
    RETURN v_current;
END;
$$;
