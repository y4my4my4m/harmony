# Which SQL Files To Run

## ✅ From This Refactor (Run These in Order!)

### 1. Server Federation (REQUIRED)
```bash
docker cp db_schema/server_federation.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/server_federation.sql
```

**What it does**: Adds columns for federated Discord servers

---

### 2. Function Cleanup (RECOMMENDED)

```bash
# Step 1: Drop old function overloads
docker cp db_schema/drop_all_overloads_first.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/drop_all_overloads_first.sql

# Step 2: Drop unnecessary functions
docker cp db_schema/drop_unnecessary_functions.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/drop_unnecessary_functions.sql

# Step 3: Add essential functions  
docker cp db_schema/essential_functions.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/essential_functions.sql
```

**What it does**: Cleans up 124 → ~15 functions

---

### 3. Smart Routing (REQUIRED for Federated Servers)
```bash
docker cp db_schema/triggers/smart_message_routing.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/triggers/smart_message_routing.sql
```

**What it does**: Routes server messages (local instant, remote federated)

---

### 4. Follow Approval (ActivityPub Compliance)
```bash
docker cp db_schema/add_follow_approval_column.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/add_follow_approval_column.sql
```

**What it does**: Adds `manually_approves_followers` column (ActivityPub standard)

---

## ⚠️ Old Migration Files (DON'T Run These!)

These are OLD migration files from BEFORE the refactor:

### In `db_schema/migrations/` folder:
```
apply-post-reactions-migration.sh          ← OLD
apply_emoji_federation_migration.sh        ← OLD
drop_old_process_incoming_emoji_reaction.sql ← OLD
emoji_reaction_federation_complete.sql     ← OLD
fix_dm_notification_structure.sql          ← OLD
fix_get_post_emoji_reactions.sql           ← OLD
fix_mention_islocal_detection.sql          ← OLD
fix_missing_ap_ids.sql                     ← OLD
fix_notification_count_function.sql        ← OLD
fix_post_interactions_constraint.sql       ← OLD
fix_post_interactions_unique_constraint.sql ← OLD
incoming_reaction_functions.sql            ← OLD
reaction_federation_functions.sql          ← OLD
set_local_post_ap_id_trigger.sql           ← OLD
```

**These were already applied OR are obsolete!** Don't run them again!

---

## 🎯 Quick Script (Run All At Once)

```bash
cd ~/gits/hobby/harmony

# Create and run migration script
cat > run_refactor_migrations.sh << 'SCRIPT'
#!/bin/bash
set -e

echo "🔧 Applying Harmony Refactor Database Migrations"
echo "================================================"

# 1. Server Federation
echo "1️⃣  Applying server federation schema..."
docker cp db_schema/server_federation.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/server_federation.sql

# 2. Function Cleanup
echo ""
echo "2️⃣  Cleaning up functions..."
docker cp db_schema/drop_all_overloads_first.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/drop_all_overloads_first.sql

docker cp db_schema/drop_unnecessary_functions.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/drop_unnecessary_functions.sql

docker cp db_schema/essential_functions.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/essential_functions.sql

# 3. Smart Routing
echo ""
echo "3️⃣  Applying smart routing triggers..."
docker cp db_schema/triggers/smart_message_routing.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/smart_message_routing.sql

# 4. Follow Approval
echo ""
echo "4️⃣  Adding follow approval column..."
docker cp db_schema/add_follow_approval_column.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/add_follow_approval_column.sql

echo ""
echo "✅ All refactor migrations applied!"
echo ""
echo "Next: Refresh your app and test bookmark icons!"
SCRIPT

chmod +x run_refactor_migrations.sh
./run_refactor_migrations.sh
```

---

## 📋 Summary

**RUN THESE** (from refactor):
1. server_federation.sql ✅
2. drop_all_overloads_first.sql ✅
3. drop_unnecessary_functions.sql ✅
4. essential_functions.sql ✅
5. triggers/smart_message_routing.sql ✅
6. add_follow_approval_column.sql ✅

**IGNORE THESE** (old migrations):
- Everything in `db_schema/migrations/` folder
- All the `fix_*.sql` files
- All the `.sh` scripts

---

## ⚠️ Optional: Naming Standardization

**Only if you want to rename `federated_id` → `ap_id`**:
```bash
docker cp db_schema/rename_federated_id_to_ap_id.sql supabase-db:/tmp/
docker exec supabase-db psql -U postgres postgres -f /tmp/rename_federated_id_to_ap_id.sql
```

**Then**: Update code (search/replace federated_id → ap_id)

**Recommendation**: Skip for now, do later if needed!

---

**Use the script above to run everything at once!** 🚀

