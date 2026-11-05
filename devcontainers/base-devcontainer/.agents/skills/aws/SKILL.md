---
name: aws
description: Find and inspect AWS resources, troubleshoot issues, and aggregate resource views across multiple AWS accounts using the AWS CLI (read-only). Use when the user asks about AWS accounts, EC2/ECS/EKS/Lambda/RDS/S3/IAM/VPC/CloudWatch/CloudTrail resources, "which account has X", or troubleshooting something running in AWS.
---

# AWS CLI (read-only)

Use `aws` for **read-only discovery and troubleshooting** across accounts. The credentials are `ViewOnlyAccess` (one profile per account), mounted read-only from `~/.aws-agent`. Default region: `ap-southeast-2` (`AWS_REGION`).

## Rules

- Read-only only: `describe-*`, `list-*`, `get-*`, `lookup-*`, `search-*`, `s3 ls`, `logs filter-log-events` etc. Never create/update/delete anything.
- A guard extension (`aws-guard`) applies:
  - **Every** aws command (and any script that calls aws/boto3) prompts the user for approval.
  - IAM/Organizations/SSO-admin changes, STS assume-role/get-session-token, destructive verbs (`delete-*`, `terminate-*`, `s3 rm`, ...), and `configure` / `sso login` are **hard-blocked**. Do not retry or work around a block; tell the user.
- Never read or print `~/.aws-agent/credentials` (blocked).
- Always pass `--profile <name>` explicitly, and `--no-cli-pager`. Prefer `--output json` + `--query` (JMESPath), or `--output table` for display.
- Avoid commands that return secrets or data content even if read-only: `secretsmanager get-secret-value`, `ssm get-parameter --with-decryption`, `s3 cp`/`s3api get-object`, `lambda get-function` (code URL), `iam get-credential-report`. Ask the user first.
- Mind cost/noise: use `--max-items`, filters, `--query`, and narrow time ranges on logs/CloudTrail.

## Credentials / expiry

- Profiles are static session credentials and **expire**. If you see `ExpiredToken`, `security token ... expired`, `InvalidClientTokenId` or `Unable to locate credentials`, **stop** and tell the user to refresh credentials outside the devcontainer. Never run `aws sso login`, `aws configure` or similar (blocked anyway).
- Check identity first: `aws sts get-caller-identity --profile <name> --no-cli-pager`.
- Expiry may hit only some profiles. In multi-account runs, report which accounts failed and continue with the rest.

## Finding accounts / profiles

```bash
aws configure list-profiles                      # all profile names (~49)
grep -B1 'account_id' "$AWS_CONFIG_FILE"         # profile -> account id mapping (comments in config)
```

Profile names look like `rest-core-log`, `rest-connect-prod`, `aws-198-rest-superannuation-api`. Match the user's description against these names; ask if ambiguous. Do not assume prod vs nonprod.

## Single-account examples

```bash
P=rest-core-log
aws ec2 describe-instances --profile $P --no-cli-pager \
  --query 'Reservations[].Instances[].{id:InstanceId,type:InstanceType,state:State.Name,name:Tags[?Key==`Name`]|[0].Value}' --output table
aws ecs list-clusters --profile $P
aws eks list-clusters --profile $P
aws lambda list-functions --profile $P --query 'Functions[].[FunctionName,Runtime,LastModified]' --output table
aws rds describe-db-instances --profile $P --query 'DBInstances[].[DBInstanceIdentifier,Engine,DBInstanceStatus]' --output table
aws s3 ls --profile $P
aws resourcegroupstaggingapi get-resources --tag-filters Key=Name,Values=foo --profile $P   # find by tag across services
aws cloudformation list-stacks --stack-status-filter CREATE_COMPLETE UPDATE_COMPLETE --profile $P
```

Other regions: `--region us-east-1`. For "where is X", check regions the user cares about; `aws ec2 describe-regions` lists enabled ones.

## Troubleshooting

```bash
# Logs
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/foo --profile $P
aws logs filter-log-events --log-group-name /aws/lambda/foo --filter-pattern ERROR \
  --start-time $(($(date +%s -d '1 hour ago')*1000)) --max-items 50 --profile $P
# Who changed what (CloudTrail, 90 days of management events)
aws cloudtrail lookup-events --lookup-attributes AttributeKey=ResourceName,AttributeValue=<name> --max-items 20 --profile $P
# Health / alarms / state
aws cloudwatch describe-alarms --state-value ALARM --profile $P
aws ecs describe-services --cluster C --services S --query 'services[].events[:5]' --profile $P
aws elbv2 describe-target-health --target-group-arn ARN --profile $P
aws ec2 describe-security-groups --group-ids sg-123 --profile $P
aws ec2 describe-network-interfaces --filters Name=addresses.private-ip-address,Values=10.0.0.5 --profile $P
# Permission questions (read-only)
aws iam get-role --role-name R --profile $P; aws iam list-attached-role-policies --role-name R --profile $P
```

AccessDenied under ViewOnlyAccess is expected for some APIs: report it, don't try to work around it.

## Multi-account aggregation

Each aws command prompts the user, so **do not loop with many separate tool calls**. Write one script (e.g. `/tmp/aws-scan.sh`) that loops over profiles, then run it once; the guard analyses the script and shows the user the aws commands inside it for a single approval. Keep scripts strictly read-only, with the aws command visible in the script (not built from variables).

```bash
#!/bin/bash
# usage: /tmp/aws-scan.sh [profile ...]  (default: all profiles)
profiles=("$@"); [ ${#profiles[@]} -eq 0 ] && mapfile -t profiles < <(aws configure list-profiles)
for p in "${profiles[@]}"; do
  out=$(aws ec2 describe-instances --profile "$p" --no-cli-pager --output json \
    --query 'Reservations[].Instances[].[InstanceId,InstanceType,State.Name]' 2>&1) || { echo "FAILED $p: ${out:0:120}" >&2; continue; }
  jq -r --arg p "$p" '.[] | [$p] + . | @tsv' <<<"$out"
done
```

Tips:
- Run profiles in parallel only modestly (e.g. `xargs -P 4`), to avoid API throttling.
- Always capture failures per profile (expired creds, AccessDenied, opt-in regions) and report them alongside results.
- Aggregate with `jq`/`column -t`; present a table with account (profile) as the first column. Say how many of the profiles succeeded.
- Prefer org-wide read APIs when available over per-account loops (e.g. `resourcegroupstaggingapi`, Config aggregators `aws configservice select-aggregate-resource-config`, from the audit/master profile) if the user has access.

## Commands that change data (never run; guard blocks or prompts)

`create-*`, `put-*`, `update-*`, `modify-*`, `run-*`, `start-*`, `delete-*`, `terminate-*`, `s3 cp/mv/rm/sync`, anything in `iam`/`organizations`/`sso-admin` that isn't get/list/describe, `sts assume-role`, `configure`, `sso login`.
