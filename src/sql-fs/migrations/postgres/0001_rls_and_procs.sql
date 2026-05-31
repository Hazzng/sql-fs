-- Migration 0001: Stored procedures for path resolution
-- Implements fs_resolve — walks a path string to an inode ID with symlink support.

-- ── Internal recursive helper ────────────────────────────────────────────────
-- Accepts an extra `p_depth` parameter to detect circular symlink chains.
-- Never call this directly from application code; use fs_resolve() below.
CREATE OR REPLACE FUNCTION fs_resolve_internal(
    p_path        TEXT,
    p_follow_last BOOLEAN,
    p_depth       INT
) RETURNS BIGINT LANGUAGE plpgsql AS $$
DECLARE
    v_sandbox_id     TEXT;
    v_root_inode     BIGINT;
    v_stack          BIGINT[];
    v_current        BIGINT;
    v_components     TEXT[];
    v_component      TEXT;
    v_next           BIGINT;
    v_kind           SMALLINT;
    v_symlink_target TEXT;
    v_is_last        BOOLEAN;
    v_i              INT;
    v_total          INT;
BEGIN
    -- Guard: too many symlink hops (ELOOP)
    IF p_depth > 40 THEN
        RAISE SQLSTATE 'FS001' USING MESSAGE = 'ELOOP: too many levels of symbolic links';
    END IF;

    v_sandbox_id := current_setting('app.sandbox_id');

    SELECT root_inode INTO v_root_inode
    FROM sandboxes
    WHERE id = v_sandbox_id;

    IF v_root_inode IS NULL THEN
        RAISE SQLSTATE 'FS002' USING MESSAGE = 'ENOENT: sandbox root not found';
    END IF;

    v_current := v_root_inode;
    v_stack   := ARRAY[v_root_inode];

    -- Tokenise path; empty segments (double-slash, leading/trailing slash) are ignored.
    v_components := ARRAY(
        SELECT seg
        FROM unnest(string_to_array(p_path, '/')) AS seg
        WHERE seg <> ''
    );
    v_total := COALESCE(array_length(v_components, 1), 0);

    -- Bare '/' — return root inode immediately.
    IF v_total = 0 THEN
        RETURN v_current;
    END IF;

    FOR v_i IN 1..v_total LOOP
        v_component := v_components[v_i];
        v_is_last   := (v_i = v_total);

        -- '.' — stay at current directory.
        IF v_component = '.' THEN
            CONTINUE;
        END IF;

        -- '..' — ascend to parent; clamp at root.
        IF v_component = '..' THEN
            IF array_length(v_stack, 1) > 1 THEN
                v_stack   := v_stack[1 : array_length(v_stack, 1) - 1];
                v_current := v_stack[array_length(v_stack, 1)];
            END IF;
            CONTINUE;
        END IF;

        -- Current inode must be a directory to descend into it.
        SELECT kind INTO v_kind FROM inodes WHERE id = v_current;
        IF v_kind <> 2 THEN
            RAISE SQLSTATE 'FS003' USING MESSAGE = 'ENOTDIR: not a directory';
        END IF;

        -- Look up the next path component in the adjacency-list.
        SELECT d.inode_id INTO v_next
        FROM dirents d
        WHERE d.parent_inode_id = v_current AND d.name = v_component;

        IF NOT FOUND THEN
            RAISE SQLSTATE 'FS002' USING MESSAGE = 'ENOENT: no such file or directory';
        END IF;

        -- Resolve symlink when it is an intermediate component, or when it is the
        -- final component and p_follow_last = true.
        SELECT kind, symlink_target INTO v_kind, v_symlink_target
        FROM inodes WHERE id = v_next;

        IF v_kind = 3 AND (NOT v_is_last OR p_follow_last) THEN
            -- Symlink target is an absolute path; resolve recursively with depth + 1.
            v_next := fs_resolve_internal(v_symlink_target, true, p_depth + 1);
        END IF;

        v_current := v_next;
        v_stack   := array_append(v_stack, v_current);
    END LOOP;

    RETURN v_current;
END;
$$;

-- ── Public entry point ────────────────────────────────────────────────────────
-- Resolves p_path to an inode ID using current_setting('app.sandbox_id').
-- Raises:
--   FS001 (ELOOP)   — circular symlink chain detected
--   FS002 (ENOENT)  — path component not found
--   FS003 (ENOTDIR) — non-directory encountered mid-path
CREATE OR REPLACE FUNCTION fs_resolve(p_path TEXT, p_follow_last BOOLEAN)
RETURNS BIGINT LANGUAGE plpgsql AS $$
BEGIN
    RETURN fs_resolve_internal(p_path, p_follow_last, 0);
END;
$$;
