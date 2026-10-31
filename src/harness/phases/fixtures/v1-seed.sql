PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE `workspace` (
          `id` text PRIMARY KEY,
          `type` text NOT NULL,
          `name` text DEFAULT '' NOT NULL,
          `branch` text,
          `directory` text,
          `extra` text,
          `project_id` text NOT NULL,
          `time_used` integer NOT NULL,
          CONSTRAINT `fk_workspace_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `data_migration` (
          `name` text PRIMARY KEY,
          `time_completed` integer NOT NULL
        );
CREATE TABLE `account_state` (
          `id` integer PRIMARY KEY,
          `active_account_id` text,
          `active_org_id` text,
          CONSTRAINT `fk_account_state_active_account_id_account_id_fk` FOREIGN KEY (`active_account_id`) REFERENCES `account`(`id`) ON DELETE SET NULL
        );
CREATE TABLE `account` (
          `id` text PRIMARY KEY,
          `email` text NOT NULL,
          `url` text NOT NULL,
          `access_token` text NOT NULL,
          `refresh_token` text NOT NULL,
          `token_expiry` integer,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
CREATE TABLE `control_account` (
          `email` text NOT NULL,
          `url` text NOT NULL,
          `access_token` text NOT NULL,
          `refresh_token` text NOT NULL,
          `token_expiry` integer,
          `active` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `control_account_pk` PRIMARY KEY(`email`, `url`)
        );
CREATE TABLE `credential` (
          `id` text PRIMARY KEY,
          `integration_id` text,
          `label` text NOT NULL,
          `value` text NOT NULL,
          `connector_id` text,
          `method_id` text,
          `active` integer,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL
        );
CREATE TABLE `event_sequence` (
          `aggregate_id` text PRIMARY KEY,
          `seq` integer NOT NULL,
          `owner_id` text
        );
INSERT INTO event_sequence VALUES('ses_e6cd8bce8ffevoleH6qb5YdQ4y',37,NULL);
INSERT INTO event_sequence VALUES('ses_e6cd8b67cffege7uiKvI6bPwzp',36,NULL);
CREATE TABLE `event` (
          `id` text PRIMARY KEY,
          `aggregate_id` text NOT NULL,
          `seq` integer NOT NULL,
          `type` text NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_event_aggregate_id_event_sequence_aggregate_id_fk` FOREIGN KEY (`aggregate_id`) REFERENCES `event_sequence`(`aggregate_id`) ON DELETE CASCADE
        );
CREATE TABLE `permission` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `action` text NOT NULL,
          `resource` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `fk_permission_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `project_directory` (
          `project_id` text NOT NULL,
          `directory` text NOT NULL,
          `type` text,
          `strategy` text,
          `time_created` integer NOT NULL,
          CONSTRAINT `project_directory_pk` PRIMARY KEY(`project_id`, `directory`),
          CONSTRAINT `fk_project_directory_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
INSERT INTO project_directory VALUES('82a477ba0df3dde90f046565c38560f67d5af64e','/private/tmp/v2-plan/probes/work/p07-v1-seed/repo',NULL,NULL,1793470186243);
CREATE TABLE `project` (
          `id` text PRIMARY KEY,
          `worktree` text NOT NULL,
          `vcs` text,
          `name` text,
          `icon_url` text,
          `icon_url_override` text,
          `icon_color` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_initialized` integer,
          `sandboxes` text NOT NULL,
          `commands` text
        );
INSERT INTO project VALUES('82a477ba0df3dde90f046565c38560f67d5af64e','/private/tmp/v2-plan/probes/work/p07-v1-seed/repo','git',NULL,NULL,NULL,NULL,1793470186240,1793470186240,NULL,'[]',NULL);
CREATE TABLE `message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
INSERT INTO message VALUES('msg_193274382001jbDqPA0bjEzkgj','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470186370,1793470187935,'{"role":"user","time":{"created":1793470186370},"agent":"build","model":{"providerID":"fake","modelID":"fixture-model"},"summary":{"diffs":[]}}');
INSERT INTO message VALUES('msg_1932744eb001Qr4YyXTb8FaJNp','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470186731,1793470187505,'{"parentID":"msg_193274382001jbDqPA0bjEzkgj","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo","root":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo"},"cost":0,"tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"fixture-model","providerID":"fake","time":{"created":1793470186731,"completed":1793470187504},"finish":"tool-calls"}');
INSERT INTO message VALUES('msg_1932747f2001iC70bFjGvGqjxd','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187506,1793470187694,'{"parentID":"msg_193274382001jbDqPA0bjEzkgj","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo","root":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo"},"cost":0,"tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"fixture-model","providerID":"fake","time":{"created":1793470187506,"completed":1793470187694},"finish":"tool-calls"}');
INSERT INTO message VALUES('msg_1932748af001sLBjsmSNhsJDHV','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187695,1793470187900,'{"parentID":"msg_193274382001jbDqPA0bjEzkgj","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo","root":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo"},"cost":0,"tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"fixture-model","providerID":"fake","time":{"created":1793470187695,"completed":1793470187900},"finish":"stop"}');
INSERT INTO message VALUES('msg_193274988001K2VivoKqeT9D0h','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470187912,1793470188360,'{"role":"user","time":{"created":1793470187912},"agent":"build","model":{"providerID":"fake","modelID":"fixture-model"},"summary":{"diffs":[]}}');
INSERT INTO message VALUES('msg_19327498c001ac0YRMXqkHNOPd','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470187916,1793470188076,'{"parentID":"msg_193274988001K2VivoKqeT9D0h","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo","root":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo"},"cost":0,"tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"fixture-model","providerID":"fake","time":{"created":1793470187916,"completed":1793470188076},"finish":"tool-calls"}');
INSERT INTO message VALUES('msg_193274a2d001un3WP0NX7SBxIG','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470188077,1793470188247,'{"parentID":"msg_193274988001K2VivoKqeT9D0h","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo","root":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo"},"cost":0,"tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"fixture-model","providerID":"fake","time":{"created":1793470188077,"completed":1793470188247},"finish":"tool-calls"}');
INSERT INTO message VALUES('msg_193274ad80014jSHVAfb7U31VE','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470188248,1793470188444,'{"parentID":"msg_193274988001K2VivoKqeT9D0h","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo","root":"/private/tmp/v2-plan/probes/work/p07-v1-seed/repo"},"cost":0,"tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"modelID":"fixture-model","providerID":"fake","time":{"created":1793470188248,"completed":1793470188444},"finish":"stop"}');
CREATE TABLE `part` (
          `id` text PRIMARY KEY,
          `message_id` text NOT NULL,
          `session_id` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_part_message_id_message_id_fk` FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON DELETE CASCADE
        );
INSERT INTO part VALUES('prt_193274384001Iw8o7v3DTjSRdH','msg_193274382001jbDqPA0bjEzkgj','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470186374,1793470186374,'{"type":"text","text":"seed prompt 0.0"}');
INSERT INTO part VALUES('prt_19327477a001x374aofF1wkJGT','msg_1932744eb001Qr4YyXTb8FaJNp','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187386,1793470187387,'{"snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-start"}');
INSERT INTO part VALUES('prt_19327477c001ieYlkL1vSROScJ','msg_1932744eb001Qr4YyXTb8FaJNp','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187388,1793470187399,'{"type":"tool","tool":"read","callID":"call_1_0","state":{"status":"completed","input":{"filePath":"/tmp/v2-plan/probes/work/p07-v1-seed/repo/big.txt"},"output":"trimmed tool output","title":"../../../../../../../tmp/v2-plan/probes/work/p07-v1-seed/repo/big.txt","time":{"start":1793470187392,"end":1793470187399}}}');
INSERT INTO part VALUES('prt_1932747bf0010CLtmhmoRSu12I','msg_1932744eb001Qr4YyXTb8FaJNp','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187456,1793470187456,'{"reason":"tool-calls","snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-finish","tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
INSERT INTO part VALUES('prt_19327482b001c4w5z7DvZqYDVK','msg_1932747f2001iC70bFjGvGqjxd','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187563,1793470187563,'{"snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-start"}');
INSERT INTO part VALUES('prt_19327482c0011JjaZ3f6vOgd2D','msg_1932747f2001iC70bFjGvGqjxd','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187564,1793470187601,'{"type":"tool","tool":"bash","callID":"call_2_0","state":{"status":"completed","input":{"command":"echo seed-0-0","description":"echo"},"output":"seed-0-0\n","title":"echo seed-0-0","time":{"start":1793470187566,"end":1793470187601}}}');
INSERT INTO part VALUES('prt_19327487d001CnXowKQ7AhC73i','msg_1932747f2001iC70bFjGvGqjxd','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187645,1793470187646,'{"reason":"tool-calls","snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-finish","tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
INSERT INTO part VALUES('prt_1932748e8001solNOBuOO99e04','msg_1932748af001sLBjsmSNhsJDHV','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187752,1793470187753,'{"snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-start"}');
INSERT INTO part VALUES('prt_1932748e9001DDCZl42fbnl3Zz','msg_1932748af001sLBjsmSNhsJDHV','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187753,1793470187769,'{"type":"text","text":"seed assistant text","time":{"start":1793470187753,"end":1793470187768}}');
INSERT INTO part VALUES('prt_19327494e001oo8gq6u8nOD5tm','msg_1932748af001sLBjsmSNhsJDHV','ses_e6cd8bce8ffevoleH6qb5YdQ4y',1793470187854,1793470187855,'{"reason":"stop","snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-finish","tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
INSERT INTO part VALUES('prt_193274989001viEUc7NeDQNgox','msg_193274988001K2VivoKqeT9D0h','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470187914,1793470187914,'{"type":"text","text":"seed prompt 1.0"}');
INSERT INTO part VALUES('prt_1932749d0001iLvBxPG06u8G3N','msg_19327498c001ac0YRMXqkHNOPd','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470187984,1793470187984,'{"snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-start"}');
INSERT INTO part VALUES('prt_1932749d1001Cjufuo7K3CEAet','msg_19327498c001ac0YRMXqkHNOPd','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470187985,1793470187989,'{"type":"tool","tool":"read","callID":"call_4_0","state":{"status":"completed","input":{"filePath":"/tmp/v2-plan/probes/work/p07-v1-seed/repo/big.txt"},"output":"trimmed tool output","title":"../../../../../../../tmp/v2-plan/probes/work/p07-v1-seed/repo/big.txt","time":{"start":1793470187986,"end":1793470187989}}}');
INSERT INTO part VALUES('prt_193274a01001Mnf0ZmrYqn0Q0w','msg_19327498c001ac0YRMXqkHNOPd','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470188033,1793470188033,'{"reason":"tool-calls","snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-finish","tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
INSERT INTO part VALUES('prt_193274a62001EZS5125kaP8QLB','msg_193274a2d001un3WP0NX7SBxIG','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470188130,1793470188131,'{"snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-start"}');
INSERT INTO part VALUES('prt_193274a63001qKZt2Ta9SgygOs','msg_193274a2d001un3WP0NX7SBxIG','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470188131,1793470188140,'{"type":"tool","tool":"bash","callID":"call_5_0","state":{"status":"completed","input":{"command":"echo seed-1-0","description":"echo"},"output":"seed-1-0\n","title":"echo seed-1-0","time":{"start":1793470188133,"end":1793470188140}}}');
INSERT INTO part VALUES('prt_193274aaa001XhzlPWC4KPBNE6','msg_193274a2d001un3WP0NX7SBxIG','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470188202,1793470188203,'{"reason":"tool-calls","snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-finish","tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
INSERT INTO part VALUES('prt_193274b2d001bwxWQAt2dc1HjR','msg_193274ad80014jSHVAfb7U31VE','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470188333,1793470188333,'{"snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-start"}');
INSERT INTO part VALUES('prt_193274b2e001j6KWeEwZnYks2j','msg_193274ad80014jSHVAfb7U31VE','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470188334,1793470188345,'{"type":"text","text":"seed assistant text","time":{"start":1793470188334,"end":1793470188345}}');
INSERT INTO part VALUES('prt_193274b72001ELscDxfVs6Ol1K','msg_193274ad80014jSHVAfb7U31VE','ses_e6cd8b67cffege7uiKvI6bPwzp',1793470188402,1793470188403,'{"reason":"stop","snapshot":"ce008647719c71316d029f3cca8cac004cb1fd7e","type":"step-finish","tokens":{"total":15,"input":10,"output":5,"reasoning":0,"cache":{"write":0,"read":0}},"cost":0}');
CREATE TABLE `session_context_epoch` (
          `session_id` text PRIMARY KEY,
          `baseline` text NOT NULL,
          `snapshot` text NOT NULL,
          `baseline_seq` integer NOT NULL,
          CONSTRAINT `fk_session_context_epoch_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session_input` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `prompt` text NOT NULL,
          `delivery` text NOT NULL,
          `admitted_seq` integer NOT NULL,
          `promoted_seq` integer,
          `time_created` integer NOT NULL,
          CONSTRAINT `fk_session_input_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session_message` (
          `id` text PRIMARY KEY,
          `session_id` text NOT NULL,
          `type` text NOT NULL,
          `seq` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `data` text NOT NULL,
          CONSTRAINT `fk_session_message_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session` (
          `id` text PRIMARY KEY,
          `project_id` text NOT NULL,
          `workspace_id` text,
          `parent_id` text,
          `slug` text NOT NULL,
          `directory` text NOT NULL,
          `path` text,
          `title` text NOT NULL,
          `version` text NOT NULL,
          `share_url` text,
          `summary_additions` integer,
          `summary_deletions` integer,
          `summary_files` integer,
          `summary_diffs` text,
          `metadata` text,
          `cost` real DEFAULT 0 NOT NULL,
          `tokens_input` integer DEFAULT 0 NOT NULL,
          `tokens_output` integer DEFAULT 0 NOT NULL,
          `tokens_reasoning` integer DEFAULT 0 NOT NULL,
          `tokens_cache_read` integer DEFAULT 0 NOT NULL,
          `tokens_cache_write` integer DEFAULT 0 NOT NULL,
          `revert` text,
          `permission` text,
          `agent` text,
          `model` text,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          `time_compacting` integer,
          `time_archived` integer,
          CONSTRAINT `fk_session_project_id_project_id_fk` FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON DELETE CASCADE
        );
INSERT INTO session VALUES('ses_e6cd8bce8ffevoleH6qb5YdQ4y','82a477ba0df3dde90f046565c38560f67d5af64e',NULL,NULL,'swift-river','/private/tmp/v2-plan/probes/work/p07-v1-seed/repo','','seed-0','1.19.4',NULL,0,0,0,NULL,NULL,0.0,30,15,0,0,0,NULL,NULL,'build','{"id":"fixture-model","providerID":"fake","variant":"default"}',1793470186263,1793470187903,NULL,NULL);
INSERT INTO session VALUES('ses_e6cd8b67cffege7uiKvI6bPwzp','82a477ba0df3dde90f046565c38560f67d5af64e',NULL,NULL,'playful-panda','/private/tmp/v2-plan/probes/work/p07-v1-seed/repo','','seed-1','1.19.4',NULL,0,0,0,NULL,NULL,0.0,30,15,0,0,0,NULL,NULL,'build','{"id":"fixture-model","providerID":"fake","variant":"default"}',1793470187907,1793470188446,NULL,NULL);
CREATE TABLE `todo` (
          `session_id` text NOT NULL,
          `content` text NOT NULL,
          `status` text NOT NULL,
          `priority` text NOT NULL,
          `position` integer NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `todo_pk` PRIMARY KEY(`session_id`, `position`),
          CONSTRAINT `fk_todo_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE `session_share` (
          `session_id` text PRIMARY KEY,
          `id` text NOT NULL,
          `secret` text NOT NULL,
          `url` text NOT NULL,
          `time_created` integer NOT NULL,
          `time_updated` integer NOT NULL,
          CONSTRAINT `fk_session_share_session_id_session_id_fk` FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON DELETE CASCADE
        );
CREATE TABLE IF NOT EXISTS "migration" (id TEXT PRIMARY KEY, time_completed INTEGER NOT NULL);
INSERT INTO migration VALUES('20260127222353_familiar_lady_ursula',1793470185924);
INSERT INTO migration VALUES('20260211171708_add_project_commands',1793470185924);
INSERT INTO migration VALUES('20260213144116_wakeful_the_professor',1793470185924);
INSERT INTO migration VALUES('20260225215848_workspace',1793470185924);
INSERT INTO migration VALUES('20260227213759_add_session_workspace_id',1793470185924);
INSERT INTO migration VALUES('20260228203230_blue_harpoon',1793470185924);
INSERT INTO migration VALUES('20260303231226_add_workspace_fields',1793470185924);
INSERT INTO migration VALUES('20260309230000_move_org_to_state',1793470185924);
INSERT INTO migration VALUES('20260312043431_session_message_cursor',1793470185924);
INSERT INTO migration VALUES('20260323234822_events',1793470185924);
INSERT INTO migration VALUES('20260410174513_workspace-name',1793470185924);
INSERT INTO migration VALUES('20260413175956_chief_energizer',1793470185924);
INSERT INTO migration VALUES('20260423070820_add_icon_url_override',1793470185924);
INSERT INTO migration VALUES('20260427172553_slow_nightmare',1793470185924);
INSERT INTO migration VALUES('20260428004200_add_session_path',1793470185924);
INSERT INTO migration VALUES('20260501142318_next_venus',1793470185924);
INSERT INTO migration VALUES('20260504145000_add_sync_owner',1793470185924);
INSERT INTO migration VALUES('20260507164347_add_workspace_time',1793470185924);
INSERT INTO migration VALUES('20260510033149_session_usage',1793470185924);
INSERT INTO migration VALUES('20260511000411_data_migration_state',1793470185924);
INSERT INTO migration VALUES('20260511173437_session-metadata',1793470185924);
INSERT INTO migration VALUES('20260601010001_normalize_storage_paths',1793470185924);
INSERT INTO migration VALUES('20260601202201_amazing_prowler',1793470185924);
INSERT INTO migration VALUES('20260602002951_lowly_union_jack',1793470185925);
INSERT INTO migration VALUES('20260602182828_add_project_directories',1793470185925);
INSERT INTO migration VALUES('20260603001617_session_message_projection_indexes',1793470185925);
INSERT INTO migration VALUES('20260603040000_session_message_projection_order',1793470185925);
INSERT INTO migration VALUES('20260603141458_session_input_inbox',1793470185925);
INSERT INTO migration VALUES('20260603160727_jittery_ezekiel_stane',1793470185925);
INSERT INTO migration VALUES('20260604172448_event_sourced_session_input',1793470185925);
INSERT INTO migration VALUES('20260605003541_add_session_context_snapshot',1793470185925);
INSERT INTO migration VALUES('20260605042240_add_context_epoch_agent',1793470185925);
INSERT INTO migration VALUES('20260611035744_credential',1793470185925);
INSERT INTO migration VALUES('20260611192811_lush_chimera',1793470185925);
INSERT INTO migration VALUES('20260612174303_project_dir_strategy',1793470185925);
INSERT INTO migration VALUES('20260622142730_simplify_session_context_epoch',1793470185925);
INSERT INTO migration VALUES('20260622170816_reset_v2_session_state',1793470185925);
INSERT INTO migration VALUES('20260622202450_simplify_session_input',1793470185925);
CREATE UNIQUE INDEX `event_aggregate_seq_idx` ON `event` (`aggregate_id`,`seq`);
CREATE INDEX `event_aggregate_type_seq_idx` ON `event` (`aggregate_id`,`type`,`seq`);
CREATE UNIQUE INDEX `permission_project_action_resource_idx` ON `permission` (`project_id`,`action`,`resource`);
CREATE INDEX `message_session_time_created_id_idx` ON `message` (`session_id`,`time_created`,`id`);
CREATE INDEX `part_message_id_id_idx` ON `part` (`message_id`,`id`);
CREATE INDEX `part_session_idx` ON `part` (`session_id`);
CREATE INDEX `session_input_session_pending_delivery_seq_idx` ON `session_input` (`session_id`,`promoted_seq`,`delivery`,`admitted_seq`);
CREATE UNIQUE INDEX `session_input_session_admitted_seq_idx` ON `session_input` (`session_id`,`admitted_seq`);
CREATE UNIQUE INDEX `session_input_session_promoted_seq_idx` ON `session_input` (`session_id`,`promoted_seq`);
CREATE UNIQUE INDEX `session_message_session_seq_idx` ON `session_message` (`session_id`,`seq`);
CREATE INDEX `session_message_session_type_seq_idx` ON `session_message` (`session_id`,`type`,`seq`);
CREATE INDEX `session_message_session_time_created_id_idx` ON `session_message` (`session_id`,`time_created`,`id`);
CREATE INDEX `session_message_time_created_idx` ON `session_message` (`time_created`);
CREATE INDEX `session_project_idx` ON `session` (`project_id`);
CREATE INDEX `session_workspace_idx` ON `session` (`workspace_id`);
CREATE INDEX `session_parent_idx` ON `session` (`parent_id`);
CREATE INDEX `todo_session_idx` ON `todo` (`session_id`);
COMMIT;
