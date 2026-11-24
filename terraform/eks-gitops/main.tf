terraform {
  required_version = ">= 1.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
    flux = {
      source  = "fluxcd/flux"
      version = "~> 1.0"
    }
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.0"
    }
    tls = {
      source = "hashicorp/tls"
      version = "~> 4.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_availability_zones" "available" {
  state = "available"
}

# ---------------------------------------------------------------------------
# Variables
# ---------------------------------------------------------------------------
variable "aws_region" {
  type    = string
  default = "ap-southeast-2"
}

variable "cluster_name" {
  type    = string
  default = "mercury-cluster"
}

variable "cluster_version" {
  type    = string
  default = "1.34"
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

# ---------------------------------------------------------------------------
# Networking
# EKS best practice: public subnets for load balancers / NAT gateway,
# private subnets for the actual worker nodes. Needs 2+ AZs minimum.
# ---------------------------------------------------------------------------
resource "aws_vpc" "eks" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name                                        = "vpc-${var.cluster_name}"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
  }
}

resource "aws_internet_gateway" "eks" {
  vpc_id = aws_vpc.eks.id

  tags = {
    Name = "igw-${var.cluster_name}"
  }
}

# Public subnets (2 AZs) - for the NAT gateway and any public-facing load balancers
resource "aws_subnet" "public" {
  count                   = 2
  vpc_id                  = aws_vpc.eks.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 8, count.index) # 10.0.0.0/24, 10.0.1.0/24
  availability_zone       = data.aws_availability_zones.available.names[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                                        = "subnet-public-${var.cluster_name}-${count.index}"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
    "kubernetes.io/role/elb"                    = "1" # required tag for public ALBs/NLBs
  }
}

# Private subnets (2 AZs) - worker nodes live here, no direct internet exposure
resource "aws_subnet" "private" {
  count             = 2
  vpc_id            = aws_vpc.eks.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 8, count.index + 10) # 10.0.10.0/24, 10.0.11.0/24
  availability_zone = data.aws_availability_zones.available.names[count.index]

  tags = {
    Name                                        = "subnet-private-${var.cluster_name}-${count.index}"
    "kubernetes.io/cluster/${var.cluster_name}" = "shared"
    "kubernetes.io/role/internal-elb"           = "1" # required tag for internal ALBs/NLBs
  }
}

# NAT Gateway - lets private-subnet nodes reach the internet (pull images, etc.)
# without being directly reachable from it. Lives in a public subnet.
resource "aws_eip" "nat" {
  domain = "vpc"

  tags = {
    Name = "eip-nat-${var.cluster_name}"
  }
}

resource "aws_nat_gateway" "eks" {
  allocation_id = aws_eip.nat.id
  subnet_id     = aws_subnet.public[0].id

  tags = {
    Name = "nat-${var.cluster_name}"
  }

  depends_on = [aws_internet_gateway.eks]
}

# Public route table - routes to the internet gateway
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.eks.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.eks.id
  }

  tags = {
    Name = "rt-public-${var.cluster_name}"
  }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Private route table - routes to the NAT gateway
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.eks.id

  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.eks.id
  }

  tags = {
    Name = "rt-private-${var.cluster_name}"
  }
}

resource "aws_route_table_association" "private" {
  count          = 2
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# ---------------------------------------------------------------------------
# IAM - control plane role
# EKS requires it to be explicit.
# ---------------------------------------------------------------------------
resource "aws_iam_role" "eks_cluster" {
  name = "${var.cluster_name}-cluster-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "eks.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_cluster_policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
  role       = aws_iam_role.eks_cluster.name
}

# Security group for the cluster control plane <-> node communication
resource "aws_security_group" "eks_cluster" {
  name        = "${var.cluster_name}-cluster-sg"
  description = "EKS cluster control plane security group"
  vpc_id      = aws_vpc.eks.id

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "${var.cluster_name}-cluster-sg"
  }
}

# ---------------------------------------------------------------------------
# EKS Cluster (control plane)
# ---------------------------------------------------------------------------
resource "aws_eks_cluster" "main" {
  name     = var.cluster_name
  role_arn = aws_iam_role.eks_cluster.arn
  version  = var.cluster_version

  vpc_config {
    subnet_ids              = concat(aws_subnet.public[*].id, aws_subnet.private[*].id)
    security_group_ids      = [aws_security_group.eks_cluster.id]
    endpoint_public_access  = true
    endpoint_private_access = true
  }

  depends_on = [aws_iam_role_policy_attachment.eks_cluster_policy]
}

# ---------------------------------------------------------------------------
# IAM - worker node role
# ---------------------------------------------------------------------------
resource "aws_iam_role" "eks_nodes" {
  name = "${var.cluster_name}-node-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action = "sts:AssumeRole"
      Effect = "Allow"
      Principal = {
        Service = "ec2.amazonaws.com"
      }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "eks_worker_node_policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy"
  role       = aws_iam_role.eks_nodes.name
}

resource "aws_iam_role_policy_attachment" "eks_cni_policy" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy"
  role       = aws_iam_role.eks_nodes.name
}

resource "aws_iam_role_policy_attachment" "eks_container_registry" {
  policy_arn = "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly"
  role       = aws_iam_role.eks_nodes.name
}

# ---------------------------------------------------------------------------
# Node Group (worker nodes)
# Placed in private subnets - no direct internet exposure, egress via NAT.
# ---------------------------------------------------------------------------
resource "aws_eks_node_group" "default" {
  cluster_name    = aws_eks_cluster.main.name
  node_group_name = "default"
  node_role_arn   = aws_iam_role.eks_nodes.arn
  subnet_ids      = aws_subnet.private[*].id

  scaling_config {
    desired_size = 1
    max_size     = 2
    min_size     = 1
  }

  instance_types = ["t3.medium"]

  depends_on = [
    aws_iam_role_policy_attachment.eks_worker_node_policy,
    aws_iam_role_policy_attachment.eks_cni_policy,
    aws_iam_role_policy_attachment.eks_container_registry,
  ]
}

# ---------------------------------------------------------------------------
# GitOps with Flux
# ---------------------------------------------------------------------------
provider "kubernetes" {
  host                   = aws_eks_cluster.main.endpoint
  cluster_ca_certificate = base64decode(aws_eks_cluster.main.certificate_authority[0].data)
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
    args        = ["eks", "get-token", "--cluster-name", aws_eks_cluster.main.name]
  }
}

provider "flux" {
  kubernetes = {
    host                   = aws_eks_cluster.main.endpoint
    cluster_ca_certificate = base64decode(aws_eks_cluster.main.certificate_authority[0].data)

    exec = {
      api_version = "client.authentication.k8s.io/v1beta1"
      command     = "aws"
      args        = ["eks", "get-token", "--cluster-name", aws_eks_cluster.main.name]
    }
  }

  git = {
    url = "ssh://git@github.com/Skux4life/mercury-gitops.git"
    ssh = {
      username    = "git"
      private_key = file("~/.ssh/mercury")
    }
  }
}

# Bootstrap Flux onto the EKS Cluster
resource "flux_bootstrap_git" "main" {
  namespace  = "flux-system"
  path       = "."
  depends_on = [aws_eks_node_group.default]
}

# ---------------------------------------------------------------------------
# Secrets Management
# ---------------------------------------------------------------------------
resource "aws_kms_key" "vault_key" {
  description             = "KMS key for mercury staging secrets"
  deletion_window_in_days = 7
}

resource "aws_secretsmanager_secret" "mercury_vault" {
  name                    = "kv-mercury-staging"
  kms_key_id              = aws_kms_key.vault_key.id
  recovery_window_in_days = 7
}

resource "random_password" "customer1_db_password" {
  length  = 24
  special = false

  lifecycle {
    ignore_changes = all
  }
}

resource "aws_secretsmanager_secret_version" "customer1_db_creds" {
  secret_id = aws_secretsmanager_secret.mercury_vault.id
  secret_string = jsonencode({
    username = "app"
    password = random_password.customer1_db_password.result
  })
}
# ---------------------------------------------------------------------------
# Service Account setup
# ---------------------------------------------------------------------------
data "tls_certificate" "eks" {
  url = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_openid_connect_provider" "eks" {
  client_id_list = ["sts.amazonaws.com"]
  thumbprint_list = [data.tls_certificate.eks.certificates[0].sha1_fingerprint]
  url             = aws_eks_cluster.main.identity[0].oidc[0].issuer
}

resource "aws_iam_role" "customer1_secrets" {
  name = "customer1-secrets-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Federated = aws_iam_openid_connect_provider.eks.arn
      }
      Action = "sts:AssumeRoleWithWebIdentity"
      Condition = {
        StringEquals = {
          "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:sub" = "system:serviceaccount:default:customer1-sa"
          "${replace(aws_iam_openid_connect_provider.eks.url, "https://", "")}:aud" = "sts.amazonaws.com"
        }
      }
    }]
  })
}

resource "aws_iam_role_policy" "customer1_secrets" {
  name = "customer1-secrets-access"
  role = aws_iam_role.customer1_secrets.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = ["secretsmanager:GetSecretValue"]
      Resource = [
        aws_secretsmanager_secret.mercury_vault.arn
      ]
    }]
  })
}
# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------
output "cluster_endpoint" {
  value = aws_eks_cluster.main.endpoint
}

output "cluster_name" {
  value = aws_eks_cluster.main.name
}

output "secrets_manager_arn" {
  value = aws_secretsmanager_secret.mercury_vault.arn
}

output "secrets_manager_name" {
  value = aws_secretsmanager_secret.mercury_vault.name
}

output "configure_kubectl" {
  value = "aws eks update-kubeconfig --region ${var.aws_region} --name ${aws_eks_cluster.main.name}"
}
